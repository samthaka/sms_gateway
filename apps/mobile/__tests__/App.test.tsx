/**
 * @format
 */

import React from 'react';
import { AppState, Text } from 'react-native';
import ReactTestRenderer from 'react-test-renderer';
import { createGatewayClient } from '@sms-gateway/api-client';
import {
  getDeviceName,
  setSecureValue,
} from '../gateway-security';
import App from '../App';
import { parsePairingQrPayload } from '../pairing-qr';
import { getPairingDeviceName } from '../device-name';

const SERVER_ID = '846c9e94-42ef-46cc-8563-254734112f27';
const PAIRING_QR = {
  version: 1,
  baseUrl: 'https://192.168.1.10:47832',
  certificatePin: 'sha256/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  pairingCode: '123456',
  serverId: SERVER_ID,
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
};

jest.mock('@sms-gateway/api-client', () => ({
  createGatewayClient: jest.fn(),
}));

jest.mock('../gateway-security', () => ({
  gatewayTransport: { request: jest.fn() },
  getDeviceName: jest.fn().mockResolvedValue(null),
  getSecureValue: jest.fn().mockResolvedValue(null),
  removeSecureValue: jest.fn().mockResolvedValue(undefined),
  setSecureValue: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('react-native-vision-camera', () => {
  const ReactModule = require('react');
  const { View: NativeView } = require('react-native');
  return {
    Camera: ({ codeScanner }: { codeScanner: unknown }) =>
      ReactModule.createElement(NativeView, {
        testID: 'pairing-camera',
        codeScanner,
      }),
    useCameraDevice: () => ({ id: 'back-camera' }),
    useCameraPermission: () => ({
      hasPermission: true,
      requestPermission: jest.fn().mockResolvedValue(true),
    }),
    useCodeScanner: (scanner: unknown) => scanner,
  };
});

jest.mock('react-native-safe-area-context', () => {
  const ReactModule = require('react');
  const { View: NativeView } = require('react-native');

  return {
    SafeAreaProvider: ({
      children,
    }: {
      children: React.ReactNode;
    }) => ReactModule.createElement(NativeView, null, children),
    SafeAreaView: ({
      children,
      ...props
    }: {
      children: React.ReactNode;
      [key: string]: unknown;
    }) => ReactModule.createElement(NativeView, props, children),
  };
});

beforeEach(() => {
  jest.clearAllMocks();
  AppState.currentState = 'active';
});

const renderedApps: ReactTestRenderer.ReactTestRenderer[] = [];

afterEach(() => {
  for (const renderer of renderedApps.splice(0)) {
    ReactTestRenderer.act(() => {
      renderer.unmount();
    });
  }
});

function renderApp(): ReactTestRenderer.ReactTestRenderer {
  let renderer: ReactTestRenderer.ReactTestRenderer | undefined;
  ReactTestRenderer.act(() => {
    renderer = ReactTestRenderer.create(<App />);
  });
  if (!renderer) {
    throw new Error('App did not render');
  }
  renderedApps.push(renderer);
  return renderer;
}

function createClientMock(overrides: Record<string, unknown> = {}) {
  return {
    getHealth: jest.fn().mockResolvedValue({ serverId: SERVER_ID }),
    pairDevice: jest.fn(),
    getPairedDevice: jest.fn(),
    getSmsQueueStatus: jest.fn().mockResolvedValue({
      asOf: new Date().toISOString(),
      queued: 0,
      sending: 0,
      sent: 0,
      failed: 0,
    }),
    getSmsJobs: jest.fn().mockResolvedValue([]),
    getNextSmsJob: jest.fn().mockResolvedValue(null),
    completeSmsJob: jest.fn(),
    retrySmsJob: jest.fn(),
    deleteFailedSmsJob: jest.fn(),
    ...overrides,
  };
}

test('rejects invalid and expired pairing QR payloads', () => {
  expect(() => parsePairingQrPayload('not json')).toThrow(/not a valid/);
  expect(() =>
    parsePairingQrPayload(
      JSON.stringify({
        ...PAIRING_QR,
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      }),
    ),
  ).toThrow(/expired/);
});

test('prefers the configured phone name and falls back to the Android model', () => {
  expect(getPairingDeviceName('  PocoX7  ', '24095PCADG')).toBe('PocoX7');
  expect(getPairingDeviceName('  ', '24095PCADG')).toBe('24095PCADG');
  expect(getPairingDeviceName(null, undefined)).toBe('Android device');
  expect(getPairingDeviceName('X'.repeat(80), undefined)).toHaveLength(60);
});

test('scans a QR code, verifies the pinned gateway identity, and pairs', async () => {
  const deviceName = 'PocoX7';
  jest.mocked(getDeviceName).mockResolvedValue(deviceName);
  const pairDevice = jest.fn().mockResolvedValue({
    deviceId: 'device-test-id',
    deviceName,
    serverId: SERVER_ID,
    token: 'opaque-test-token',
  });
  jest.mocked(createGatewayClient).mockReturnValue(
    createClientMock({ pairDevice }),
  );

  const renderer = renderApp();
  await ReactTestRenderer.act(async () => {
    renderer.root
      .findByProps({ testID: 'scan-pairing-qr-button' })
      .props.onPress();
  });

  const camera = renderer.root.findByProps({ testID: 'pairing-camera' });
  await ReactTestRenderer.act(async () => {
    camera.props.codeScanner.onCodeScanned([
      { value: JSON.stringify(PAIRING_QR) },
    ]);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  });

  expect(createGatewayClient).toHaveBeenCalledWith(
    PAIRING_QR.baseUrl,
    PAIRING_QR.certificatePin,
    expect.anything(),
  );
  expect(pairDevice).toHaveBeenCalledWith({
    code: PAIRING_QR.pairingCode,
    deviceName,
  });
  expect(setSecureValue).toHaveBeenCalledWith(
    'paired-gateway',
    expect.stringContaining('opaque-test-token'),
  );
  expect(
    renderer.root
      .findAllByType(Text)
      .some((text) => text.props.children === 'Device paired'),
  ).toBe(true);
  expect(
    renderer.root.findByProps({ testID: 'send-queued-messages-button' })
      .props.disabled,
  ).toBe(true);
});

test('shows pending and failed jobs and lets the user retry a failed message', async () => {
  const failedJob = {
    id: 'a5f07fd8-89cf-4e62-a4d3-68e9ed229e92',
    phoneNumber: '+254700000001',
    message: 'Hello',
    status: 'failed' as const,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    failureReason: 'SIM unavailable',
  };
  const pendingJob = {
    ...failedJob,
    id: 'b6f07fd8-89cf-4e62-a4d3-68e9ed229e93',
    phoneNumber: '+254700000002',
    status: 'queued' as const,
    failureReason: undefined,
  };
  const retrySmsJob = jest.fn().mockResolvedValue({
    ...failedJob,
    status: 'queued',
    failureReason: undefined,
  });
  const getSmsJobs = jest.fn()
    .mockResolvedValueOnce([pendingJob, failedJob])
    .mockResolvedValue([pendingJob, { ...failedJob, status: 'queued' }]);
  jest.mocked(createGatewayClient).mockReturnValue(
    createClientMock({
      getSmsJobs,
      retrySmsJob,
      pairDevice: jest.fn().mockResolvedValue({
        deviceId: 'device-test-id',
        deviceName: 'Test Android',
        serverId: SERVER_ID,
        token: 'opaque-test-token',
      }),
    }),
  );

  const renderer = renderApp();
  await ReactTestRenderer.act(async () => {
    renderer.root
      .findByProps({ testID: 'scan-pairing-qr-button' })
      .props.onPress();
  });
  const camera = renderer.root.findByProps({ testID: 'pairing-camera' });
  await ReactTestRenderer.act(async () => {
    camera.props.codeScanner.onCodeScanned([
      { value: JSON.stringify(PAIRING_QR) },
    ]);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  });

  expect(
    renderer.root.findAllByType(Text).some((text) => text.props.children === 'Hello'),
  ).toBe(true);
  expect(
    renderer.root.findAllByType(Text).some((text) => text.props.children === 'SIM unavailable'),
  ).toBe(true);
  await ReactTestRenderer.act(async () => {
    renderer.root
      .findByProps({ testID: `retry-failed-job-${failedJob.id}` })
      .props.onPress();
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  });
  expect(retrySmsJob).toHaveBeenCalledWith('opaque-test-token', failedJob.id);
  expect(
    renderer.root.findAllByType(Text).some((text) => text.props.children === 'No failed attempts.'),
  ).toBe(true);
});

test('does not send the pairing code when the server identity mismatches', async () => {
  const pairDevice = jest.fn();
  jest.mocked(createGatewayClient).mockReturnValue(
    createClientMock({
      getHealth: jest.fn().mockResolvedValue({
      serverId: 'e0a9290e-b7f3-4b50-9d08-fd441d3d66ac',
    }),
      pairDevice,
    }),
  );

  const renderer = renderApp();
  await ReactTestRenderer.act(async () => {
    renderer.root
      .findByProps({ testID: 'scan-pairing-qr-button' })
      .props.onPress();
  });
  const camera = renderer.root.findByProps({ testID: 'pairing-camera' });
  await ReactTestRenderer.act(async () => {
    camera.props.codeScanner.onCodeScanned([
      { value: JSON.stringify(PAIRING_QR) },
    ]);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  });

  expect(pairDevice).not.toHaveBeenCalled();
  expect(setSecureValue).not.toHaveBeenCalledWith(
    'paired-gateway',
    expect.any(String),
  );
});
