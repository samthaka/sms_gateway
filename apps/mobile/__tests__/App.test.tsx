/**
 * @format
 */

import React from 'react';
import { Text } from 'react-native';
import ReactTestRenderer from 'react-test-renderer';
import { createGatewayClient } from '@sms-gateway/api-client';
import {
  inspectGatewayCertificate,
  setSecureValue,
} from '../gateway-security';
import App from '../App';

jest.mock('@sms-gateway/api-client', () => ({
  createGatewayClient: jest.fn(),
}));

jest.mock('../gateway-security', () => ({
  gatewayTransport: { request: jest.fn() },
  getSecureValue: jest.fn().mockResolvedValue(null),
  inspectGatewayCertificate: jest.fn(),
  removeSecureValue: jest.fn().mockResolvedValue(undefined),
  setSecureValue: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('react-native-safe-area-context', () => {
  const ReactModule = require('react');
  const { View } = require('react-native');

  return {
    SafeAreaProvider: ({
      children,
    }: {
      children: React.ReactNode;
    }) => ReactModule.createElement(View, null, children),
    SafeAreaView: ({
      children,
      ...props
    }: {
      children: React.ReactNode;
      [key: string]: unknown;
    }) => ReactModule.createElement(View, props, children),
  };
});

function renderApp(): ReactTestRenderer.ReactTestRenderer {
  let renderer: ReactTestRenderer.ReactTestRenderer | undefined;
  ReactTestRenderer.act(() => {
    renderer = ReactTestRenderer.create(<App />);
  });
  if (!renderer) {
    throw new Error('App did not render');
  }
  return renderer;
}

test('asks to inspect the desktop certificate before showing pairing fields', () => {
  const renderer = renderApp();

  expect(
    renderer.root.findByProps({ testID: 'gateway-address-input' }),
  ).toBeTruthy();
  expect(
    renderer.root.findByProps({ testID: 'inspect-certificate-button' }),
  ).toBeTruthy();
  expect(
    renderer.root.findAllByProps({ testID: 'pairing-code-input' }),
  ).toHaveLength(0);
});

test('reveals pairing only after fingerprint inspection and explicit confirmation', async () => {
  jest.mocked(inspectGatewayCertificate).mockResolvedValue(
    'sha256/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  );
  const renderer = renderApp();
  const inspectButton = renderer.root.findByProps({
    testID: 'inspect-certificate-button',
  });

  await ReactTestRenderer.act(async () => {
    await inspectButton.props.onPress();
  });

  expect(
    renderer.root.findByProps({ testID: 'trust-certificate-button' }),
  ).toBeTruthy();
  expect(
    renderer.root.findAllByProps({ testID: 'pairing-code-input' }),
  ).toHaveLength(0);

  const trustButton = renderer.root.findByProps({
    testID: 'trust-certificate-button',
  });
  ReactTestRenderer.act(() => {
    trustButton.props.onPress();
  });

  expect(
    renderer.root.findByProps({ testID: 'pairing-code-input' }),
  ).toBeTruthy();
});

test('pairs the phone and stores its credential using secure storage', async () => {
  const pairDevice = jest.fn().mockResolvedValue({
    deviceId: 'device-test-id',
    deviceName: 'Android gateway',
    serverId: 'server-test-id',
    token: 'opaque-test-token',
  });
  jest.mocked(createGatewayClient).mockReturnValue({
    getHealth: jest.fn(),
    pairDevice,
    getPairedDevice: jest.fn(),
  });
  jest.mocked(inspectGatewayCertificate).mockResolvedValue(
    'sha256/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  );

  const renderer = renderApp();
  await ReactTestRenderer.act(async () => {
    await renderer.root
      .findByProps({ testID: 'inspect-certificate-button' })
      .props.onPress();
  });
  ReactTestRenderer.act(() => {
    renderer.root
      .findByProps({ testID: 'trust-certificate-button' })
      .props.onPress();
  });

  ReactTestRenderer.act(() => {
    renderer.root
      .findByProps({ testID: 'pairing-code-input' })
      .props.onChangeText('123456');
  });

  await ReactTestRenderer.act(async () => {
    await renderer.root
      .findByProps({ testID: 'pair-device-button' })
      .props.onPress();
  });

  expect(pairDevice).toHaveBeenCalledWith({
    code: '123456',
    deviceName: 'Android gateway',
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
});
