import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { randomUUID } from 'node:crypto';
import QRCode from 'qrcode';
import path from 'node:path';
import { startGatewayServer, type GatewayRuntime } from './gateway-server';
import {
  deleteSpreadsheetUpload,
  listSpreadsheetUploads,
  storeSpreadsheetUpload,
} from './upload-storage';
import { readSpreadsheetRows, readSpreadsheetSheets } from './spreadsheet-reader';
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
    icon: path.join(__dirname, 'desktop.png'),
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

ipcMain.handle('gateway:get-sms-queue-status', () => {
  if (!gateway) {
    throw new Error('Gateway service is not running');
  }
  return gateway.getSmsQueueStatus();
});

ipcMain.handle('gateway:get-sms-jobs', () => {
  if (!gateway) {
    throw new Error('Gateway service is not running');
  }
  return gateway.getSmsJobs();
});

ipcMain.handle('gateway:retry-sms-job', async (_event, jobId: unknown) => {
  if (!gateway) {
    throw new Error('Gateway service is not running');
  }
  if (
    typeof jobId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(jobId)
  ) {
    throw new TypeError('SMS job ID is invalid');
  }
  const result = await gateway.retrySmsJob(jobId);
  if (result.status === 'not-found') {
    throw new Error('SMS job was not found');
  }
  if (result.status === 'not-failed') {
    throw new Error('SMS job is not failed');
  }
  return result.job;
});

ipcMain.handle('gateway:delete-failed-sms-job', async (_event, jobId: unknown) => {
  if (!gateway) {
    throw new Error('Gateway service is not running');
  }
  if (
    typeof jobId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(jobId)
  ) {
    throw new TypeError('SMS job ID is invalid');
  }
  const result = await gateway.deleteFailedSmsJob(jobId);
  if (result === 'not-found') {
    throw new Error('SMS job was not found');
  }
  if (result === 'not-failed') {
    throw new Error('Only failed SMS jobs can be deleted');
  }
  return { deleted: true };
});

ipcMain.handle('gateway:enqueue-spreadsheet-campaign', async (_event, input: unknown) => {
  if (!gateway) {
    throw new Error('Gateway service is not running');
  }
  if (
    typeof input !== 'object' ||
    input === null ||
    !('uploadId' in input) ||
    typeof input.uploadId !== 'string' ||
    !('sheetNumber' in input) ||
    typeof input.sheetNumber !== 'number' ||
    !('phoneHeader' in input) ||
    typeof input.phoneHeader !== 'string' ||
    !('template' in input) ||
    typeof input.template !== 'string' ||
    !('deviceId' in input) ||
    typeof input.deviceId !== 'string'
  ) {
    throw new TypeError('Spreadsheet campaign details are invalid');
  }
  if (input.template.trim().length === 0) {
    throw new TypeError('Enter a message before queuing a campaign');
  }
  const phoneHeader = input.phoneHeader;
  const template = input.template;

  const rows = await readSpreadsheetRows(
    path.join(app.getPath('userData'), 'uploads'),
    input.uploadId,
    input.sheetNumber,
  );
  if (rows.length === 0) {
    throw new Error('The selected sheet contains no data rows');
  }

  const requests = rows.map((row) => {
    const phoneCell = row.values.find(
      (value) => value.header === phoneHeader,
    );
    const phoneText = phoneCell?.value.trim() ?? '';
    if (!/^\+?[\d\s().-]+$/.test(phoneText)) {
      throw new TypeError(
        `Invalid phone number in spreadsheet row ${row.rowNumber}`,
      );
    }
    const phoneNumber = phoneText.replace(/[\s().-]/g, '');
    if (!/^\+?[0-9]{7,15}$/.test(phoneNumber)) {
      throw new TypeError(
        `Invalid phone number in spreadsheet row ${row.rowNumber}`,
      );
    }

    let message = template;
    for (const { header, value } of row.values) {
      message = message.split(`{${header}}`).join(value);
    }
    if (!message.trim()) {
      throw new TypeError(
        `Message is empty for spreadsheet row ${row.rowNumber}`,
      );
    }
    return {
      phoneNumber,
      message,
      idempotencyKey: randomUUID(),
    };
  });

  const enqueued = await gateway.enqueueSmsBatch(input.deviceId, requests);
  return {
    enqueued,
    queueStatus: gateway.getSmsQueueStatus(),
  };
});

ipcMain.handle('uploads:list-spreadsheets', () =>
  listSpreadsheetUploads(path.join(app.getPath('userData'), 'uploads')),
);

ipcMain.handle('uploads:delete-spreadsheet', async (_event, uploadId: unknown) => {
  if (typeof uploadId !== 'string') {
    throw new TypeError('Spreadsheet ID must be a string');
  }
  const uploadDir = path.join(app.getPath('userData'), 'uploads');
  await deleteSpreadsheetUpload(uploadDir, uploadId);
  return listSpreadsheetUploads(uploadDir);
});

ipcMain.handle('uploads:select-spreadsheet', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [
      { name: 'Excel spreadsheets', extensions: ['xls', 'xlsx'] },
    ],
  });
  const uploaded = !result.canceled && result.filePaths.length > 0;
  const savedUpload = uploaded
    ? await storeSpreadsheetUpload(
      path.join(app.getPath('userData'), 'uploads'),
      result.filePaths[0],
    )
    : undefined;
  return {
    uploads: await listSpreadsheetUploads(
      path.join(app.getPath('userData'), 'uploads'),
    ),
    uploaded,
    selectedUploadId: savedUpload?.id ?? null,
  };
});

ipcMain.handle('uploads:read-sheets', async (_event, uploadId: unknown) => {
  if (typeof uploadId !== 'string') {
    throw new TypeError('Spreadsheet ID must be a string');
  }
  return readSpreadsheetSheets(
    path.join(app.getPath('userData'), 'uploads'),
    uploadId,
  );
});

app.whenReady()
  .then(async () => {
    if (process.platform === 'darwin') {
      app.dock?.setIcon(path.join(__dirname, 'desktop.png'));
    }
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
