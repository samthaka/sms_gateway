/**
 * @format
 */

import React from 'react';
import { Text } from 'react-native';
import ReactTestRenderer from 'react-test-renderer';
import { fetchGatewayHealth } from '@sms-gateway/api-client';
import App from '../App';

jest.mock('@sms-gateway/api-client', () => ({
  fetchGatewayHealth: jest.fn(),
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

test('renders correctly', async () => {
  let renderer: ReactTestRenderer.ReactTestRenderer | undefined;
  await ReactTestRenderer.act(() => {
    renderer = ReactTestRenderer.create(<App />);
  });

  if (!renderer) {
    throw new Error('App did not render');
  }

  expect(
    renderer.root.findByProps({ testID: 'gateway-address-input' }),
  ).toBeTruthy();
  expect(
    renderer.root.findByProps({ testID: 'connect-gateway-button' }),
  ).toBeTruthy();
});

test('verifies the desktop gateway and shows the connected state', async () => {
  jest.mocked(fetchGatewayHealth).mockResolvedValue({
    status: 'ok',
    protocolVersion: 1,
    serverId: 'gateway-test-id',
  });

  let renderer: ReactTestRenderer.ReactTestRenderer | undefined;
  await ReactTestRenderer.act(() => {
    renderer = ReactTestRenderer.create(<App />);
  });

  if (!renderer) {
    throw new Error('App did not render');
  }

  const connectButton = renderer.root.findByProps({
    testID: 'connect-gateway-button',
  });
  await ReactTestRenderer.act(async () => {
    await connectButton.props.onPress();
  });

  expect(fetchGatewayHealth).toHaveBeenCalledWith('http://10.0.2.2:47832');
  expect(
    renderer.root
      .findAllByType(Text)
      .some((text) => text.props.children === 'Connected to desktop'),
  ).toBe(true);
});
