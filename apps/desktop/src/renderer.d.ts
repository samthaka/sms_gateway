import type { DesktopGatewayStatus } from '@sms-gateway/shared-contracts';

interface DesktopPairingQrCode {
  address: string;
  dataUrl: string;
}

interface DesktopDisplayStatus extends DesktopGatewayStatus {
  pairingQrCodes: DesktopPairingQrCode[];
}

declare global {
  interface Window {
    smsGateway: {
      getStatus(): Promise<DesktopDisplayStatus>;
      rotatePairingCode(): Promise<DesktopDisplayStatus>;
      revokeDevice(deviceId: string): Promise<DesktopDisplayStatus>;
    };
  }
}

export {};
