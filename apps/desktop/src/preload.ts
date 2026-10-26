import { contextBridge, ipcRenderer } from 'electron';
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

contextBridge.exposeInMainWorld('smsGateway', {
  getStatus: (): Promise<DesktopDisplayStatus> =>
    ipcRenderer.invoke('gateway:get-status'),
  rotatePairingCode: (): Promise<DesktopDisplayStatus> =>
    ipcRenderer.invoke('gateway:rotate-pairing-code'),
  revokeDevice: (deviceId: string): Promise<DesktopDisplayStatus> =>
    ipcRenderer.invoke('gateway:revoke-device', deviceId),
  listSpreadsheetUploads: (): Promise<SpreadsheetUpload[]> =>
    ipcRenderer.invoke('uploads:list-spreadsheets'),
  selectSpreadsheet: (): Promise<SpreadsheetUploadSelection> =>
    ipcRenderer.invoke('uploads:select-spreadsheet'),
});
