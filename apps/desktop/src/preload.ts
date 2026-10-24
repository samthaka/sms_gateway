import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopGatewayStatus } from '@sms-gateway/shared-contracts';

contextBridge.exposeInMainWorld('smsGateway', {
  getStatus: (): Promise<DesktopGatewayStatus> =>
    ipcRenderer.invoke('gateway:get-status'),
  rotatePairingCode: (): Promise<DesktopGatewayStatus> =>
    ipcRenderer.invoke('gateway:rotate-pairing-code'),
  revokeDevice: (deviceId: string): Promise<DesktopGatewayStatus> =>
    ipcRenderer.invoke('gateway:revoke-device', deviceId),
});
