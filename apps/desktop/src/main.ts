import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import QRCode from 'qrcode';
import path from 'node:path';
import { startGatewayServer, type GatewayRuntime } from './gateway-server';
import { listSpreadsheetUploads, storeSpreadsheetUpload } from './upload-storage';
import type { DesktopGatewayStatus, PairingQrPayload } from '@sms-gateway/shared-contracts';

let gateway: GatewayRuntime | undefined;
let quitting = false;

interface DesktopPairingQrCode {
  address: string;
  dataUrl: string;
}

interface DesktopDisplayStatus extends DesktopGatewayStatus {
  pairingQrCodes: DesktopPairingQrCode[];
}

async function getDisplayStatus(): Promise<DesktopDisplayStatus> {
  if (!gateway) {
    throw new Error('Gateway service is not running');
  }
  const status = gateway.getStatus();
  const pairingQrCodes =
    status.pairingCode === 'expired'
      ? []
      : await Promise.all(
          status.addresses.map(async (address) => {
            const payload: PairingQrPayload = {
              version: 1,
              baseUrl: address,
              certificatePin: status.certificatePin,
              pairingCode: status.pairingCode,
              serverId: status.serverId,
              expiresAt: status.pairingCodeExpiresAt,
            };
            return {
              address,
              dataUrl: await QRCode.toDataURL(JSON.stringify(payload), {
                errorCorrectionLevel: 'M',
                margin: 2,
                width: 280,
              }),
            };
          }),
        );
  return { ...status, pairingQrCodes };
}

function createMainWindow(): void {
  const window = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 760,
    minHeight: 560,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  void window
    .loadFile(path.join(__dirname, 'renderer', 'index.html'))
    .catch((error: unknown) => {
      console.error('Failed to load the desktop window:', error);
    });
}

ipcMain.handle('gateway:get-status', getDisplayStatus);

ipcMain.handle('gateway:rotate-pairing-code', () => {
  if (!gateway) {
    throw new Error('Gateway service is not running');
  }
  gateway.rotatePairingCode();
  return getDisplayStatus();
});

ipcMain.handle('gateway:revoke-device', async (_event, deviceId: unknown) => {
  if (!gateway) {
    throw new Error('Gateway service is not running');
  }
  if (typeof deviceId !== 'string') {
    throw new TypeError('Device ID must be a string');
  }
  await gateway.revokeDevice(deviceId);
  return getDisplayStatus();
});

ipcMain.handle('uploads:list-spreadsheets', () =>
  listSpreadsheetUploads(path.join(app.getPath('userData'), 'uploads')),
);

ipcMain.handle('uploads:select-spreadsheet', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [
      { name: 'Excel spreadsheets', extensions: ['xls', 'xlsx'] },
    ],
  });
  const uploaded = !result.canceled && result.filePaths.length > 0;
  if (uploaded) {
    await storeSpreadsheetUpload(
      path.join(app.getPath('userData'), 'uploads'),
      result.filePaths[0],
    );
  }
  return {
    uploads: await listSpreadsheetUploads(
      path.join(app.getPath('userData'), 'uploads'),
    ),
    uploaded,
  };
});

app.whenReady()
  .then(async () => {
    gateway = await startGatewayServer({
      storageDir: path.join(app.getPath('userData'), 'gateway'),
    });
    createMainWindow();
  })
  .catch((error: unknown) => {
    console.error('Failed to start the desktop application:', error);
    dialog.showErrorBox(
      'Unable to start SMS Gateway',
      error instanceof Error ? error.message : String(error),
    );
    app.quit();
  });

app.on('before-quit', (event) => {
  if (!gateway || quitting) {
    return;
  }

  event.preventDefault();
  quitting = true;
  void gateway.close()
    .then(() => app.quit())
    .catch((error: unknown) => {
      console.error('Failed to stop the gateway service:', error);
      app.quit();
    });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
