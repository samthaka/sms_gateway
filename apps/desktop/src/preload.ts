import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopGatewayStatus } from '@sms-gateway/shared-contracts';

interface DesktopPairingQrCode {
  address: string;
  dataUrl: string;
}

interface DesktopDisplayStatus extends DesktopGatewayStatus {
  pairingQrCodes: DesktopPairingQrCode[];
}

contextBridge.exposeInMainWorld('smsGateway', {
  getStatus: (): Promise<DesktopDisplayStatus> =>
    ipcRenderer.invoke('gateway:get-status'),
  rotatePairingCode: (): Promise<DesktopDisplayStatus> =>
    ipcRenderer.invoke('gateway:rotate-pairing-code'),
  revokeDevice: (deviceId: string): Promise<DesktopDisplayStatus> =>
    ipcRenderer.invoke('gateway:revoke-device', deviceId),
});
