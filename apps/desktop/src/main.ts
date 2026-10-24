import { app, BrowserWindow } from 'electron';
import path from 'node:path';

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
    },
  });

  void window
    .loadFile(path.join(__dirname, 'renderer', 'index.html'))
    .catch((error: unknown) => {
      console.error('Failed to load the desktop window:', error);
    });
}

app.whenReady()
  .then(createMainWindow)
  .catch((error: unknown) => {
    console.error('Failed to start the desktop application:', error);
    app.quit();
  });

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
