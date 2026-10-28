import { NativeModules } from 'react-native';
import type {
  GatewayHttpResponse,
  GatewayTransport,
} from '@sms-gateway/api-client';

interface GatewaySecurityNativeModule {
  getDeviceName(): Promise<string | null>;
  sendSms(jobId: string, phoneNumber: string, message: string): Promise<void>;
  getPendingDeliveryReports(): Promise<
    { jobId: string; status: 'delivered' | 'not-delivered' }[]
  >;
  acknowledgeDeliveryReport(jobId: string): Promise<void>;
  inspectCertificate(url: string): Promise<string>;
  requestPinned(
    url: string,
    pin: string,
    method: 'GET' | 'POST' | 'DELETE',
    body: string | null,
    token: string | null,
  ): Promise<GatewayHttpResponse>;
  getSecureValue(key: string): Promise<string | null>;
  setSecureValue(key: string, value: string): Promise<void>;
  removeSecureValue(key: string): Promise<void>;
}

function getNativeModule(): GatewaySecurityNativeModule {
  const nativeModule = NativeModules.GatewaySecurity as
    | GatewaySecurityNativeModule
    | undefined;
  if (!nativeModule) {
    throw new Error('Pinned gateway connections are currently supported on Android only.');
  }
  return nativeModule;
}

export function inspectGatewayCertificate(healthUrl: string): Promise<string> {
  return getNativeModule().inspectCertificate(healthUrl);
}

export function getDeviceName(): Promise<string | null> {
  return getNativeModule().getDeviceName();
}

export function sendSms(
  jobId: string,
  phoneNumber: string,
  message: string,
): Promise<void> {
  return getNativeModule().sendSms(jobId, phoneNumber, message);
}

export function getPendingDeliveryReports(): Promise<
  { jobId: string; status: 'delivered' | 'not-delivered' }[]
> {
  return getNativeModule().getPendingDeliveryReports();
}

export function acknowledgeDeliveryReport(jobId: string): Promise<void> {
  return getNativeModule().acknowledgeDeliveryReport(jobId);
}

export const gatewayTransport: GatewayTransport = {
  request: (url, pin, method, body, token) =>
    getNativeModule().requestPinned(
      url,
      pin,
      method,
      body ?? null,
      token ?? null,
    ),
};

export function getSecureValue(key: string): Promise<string | null> {
  return Promise.resolve().then(() => getNativeModule().getSecureValue(key));
}

export function setSecureValue(key: string, value: string): Promise<void> {
  return getNativeModule().setSecureValue(key, value);
}

export function removeSecureValue(key: string): Promise<void> {
  return getNativeModule().removeSecureValue(key);
}
