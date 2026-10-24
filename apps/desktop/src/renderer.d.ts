import type { DesktopGatewayStatus } from '@sms-gateway/shared-contracts';

declare global {
  interface Window {
    smsGateway: {
      getStatus(): Promise<DesktopGatewayStatus>;
      rotatePairingCode(): Promise<DesktopGatewayStatus>;
      revokeDevice(deviceId: string): Promise<DesktopGatewayStatus>;
    };
  }
}

export {};
