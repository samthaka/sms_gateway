import type { DesktopGatewayStatus } from '@sms-gateway/shared-contracts';
import type { SpreadsheetUpload } from './upload-storage';
import type { SpreadsheetSheet } from './spreadsheet-reader';

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
  selectedUploadId: string | null;
}

declare global {
  interface Window {
    smsGateway: {
      getStatus(): Promise<DesktopDisplayStatus>;
      rotatePairingCode(): Promise<DesktopDisplayStatus>;
      revokeDevice(deviceId: string): Promise<DesktopDisplayStatus>;
      listSpreadsheetUploads(): Promise<SpreadsheetUpload[]>;
      deleteSpreadsheetUpload(uploadId: string): Promise<SpreadsheetUpload[]>;
      selectSpreadsheet(): Promise<SpreadsheetUploadSelection>;
      readSpreadsheetSheets(uploadId: string): Promise<SpreadsheetSheet[]>;
    };
  }
}

export {};
