import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import path from 'node:path';
import { startGatewayServer, type GatewayRuntime } from './gateway-server';

let gateway: GatewayRuntime | undefined;
let quitting = false;

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

ipcMain.handle('gateway:get-status', () => {
  if (!gateway) {
    throw new Error('Gateway service is not running');
  }
  return gateway.getStatus();
});

ipcMain.handle('gateway:rotate-pairing-code', () => {
  if (!gateway) {
    throw new Error('Gateway service is not running');
  }
  return gateway.rotatePairingCode();
});

ipcMain.handle('gateway:revoke-device', async (_event, deviceId: unknown) => {
  if (!gateway) {
    throw new Error('Gateway service is not running');
  }
  if (typeof deviceId !== 'string') {
    throw new TypeError('Device ID must be a string');
  }
  await gateway.revokeDevice(deviceId);
  return gateway.getStatus();
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
