import type { DesktopGatewayStatus } from '@sms-gateway/shared-contracts';
import type { SpreadsheetUpload } from './upload-storage';

interface DesktopPairingQrCode {
  address: string;
  dataUrl: string;
}

interface DesktopDisplayStatus extends DesktopGatewayStatus {
  pairingQrCodes: DesktopPairingQrCode[];
}

interface SpreadsheetUploadSelection {
  uploads: SpreadsheetUpload[];
  uploaded: boolean;
}

declare global {
  interface Window {
    smsGateway: {
      getStatus(): Promise<DesktopDisplayStatus>;
      rotatePairingCode(): Promise<DesktopDisplayStatus>;
      revokeDevice(deviceId: string): Promise<DesktopDisplayStatus>;
      listSpreadsheetUploads(): Promise<SpreadsheetUpload[]>;
      selectSpreadsheet(): Promise<SpreadsheetUploadSelection>;
    };
  }
}

export {};
