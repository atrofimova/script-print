const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { execFile } = require('node:child_process');
const { getPdfInfo } = require('./pdf.js');

// Sets the name used in this app's own menu bar labels (e.g. "About Print
// Preset", "Quit Print Preset") and app.getName(). Doesn't change what
// macOS shows in the dock tooltip / Cmd+Tab switcher in dev mode — that's
// tied to the actual running binary's bundle name (generic Electron.app
// while developing) and only becomes "Print Preset" once packaged via
// `npm run build:mac`, which produces a real Print Preset.app bundle.
app.setName('Script Print');

let mainWindow;

// electron-builder applies build-resources/icon.icns (macOS) and icon.ico
// (Windows) automatically to *built* installers, but build-resources/
// itself isn't bundled into the packaged app's contents — only files
// listed under "files" in package.json's build config ship with it. This
// copy lives in electron/ (which is bundled) so the running app can load
// it at runtime for the dev-mode/dock window icon.
const appIconPath = path.join(__dirname, 'icon.png');

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    title: 'Print Preset',
    icon: appIconPath,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  const startUrl =
      process.env.ELECTRON_START_URL ||
      `file://${path.join(__dirname, '..', 'frontend', 'dist', 'index.html')}`;

  mainWindow.loadURL(startUrl);

  if (process.env.ELECTRON_START_URL) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
}

// macOS dock icon isn't picked up from the BrowserWindow's `icon` option in
// dev mode the way it is on Windows/Linux taskbars — set it on app.dock
// explicitly. app.dock is undefined on non-macOS platforms.
if (process.platform === 'darwin' && app.dock) {
  app.dock.setIcon(appIconPath);
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---- IPC: file picking ----
ipcMain.handle('files:open-dialog', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'PDF Documents', extensions: ['pdf'] }],
  });
  if (result.canceled) return [];
  return Promise.all(result.filePaths.map((p) => readFileMeta(p)));
});

async function readFileMeta(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext !== '.pdf') {
    throw new Error(`Unsupported file type "${ext}" — only PDF files can be added to the queue.`);
  }

  const stat = await fs.stat(filePath);
  const info = await getPdfInfo(filePath);

  return {
    path: filePath,
    name: path.basename(filePath),
    sizeBytes: stat.size,
    pages: info.pages,
    hasColor: info.hasColor,
    ext,
  };
}

// Dropped files come in as absolute paths from the renderer (via webUtils.getPathForFile)
ipcMain.handle('files:read-meta', async (_event, filePath) => readFileMeta(filePath));

// ---- IPC: printers ----
ipcMain.handle('printers:list', async () => {
  const printers = await mainWindow.webContents.getPrintersAsync();
  return printers.map((p) => ({
    name: p.name,
    displayName: p.displayName || p.name,
    isDefault: !!p.isDefault,
    status: p.status,
  }));
});

// ---- IPC: printing ----
// Prints each queued PDF by submitting it to the OS's native print system.
ipcMain.handle('print:submit', async (_event, { files, printerName, color, duplex, staple, staplePlacement }) => {
  const results = [];
  for (const file of files) {
    try {
      await printFile(file.path, { printerName, color, duplex, staple, staplePlacement });
      results.push({ path: file.path, success: true });
    } catch (err) {
      results.push({ path: file.path, success: false, error: String(err.message || err) });
    }
  }
  const failed = results.filter((r) => !r.success);
  if (failed.length) {
    return { success: false, results, error: `${failed.length} of ${files.length} file(s) failed to print` };
  }
  return { success: true, results };
});

// Prints a PDF by submitting it directly to the OS's native print system
// (CUPS on macOS/Linux via the `lp` command; Windows uses a separate path
// below). This bypasses Chromium's built-in PDF viewer + webContents.print,
// which is unreliable for local PDFs — it can render blank pages or hang
// indefinitely waiting on print-pipeline state that never resolves.
async function printFile(filePath, { printerName, color, duplex, staple, staplePlacement }) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext !== '.pdf') {
    throw new Error(`Unsupported file type "${ext}" — only PDF files can be printed.`);
  }

  if (process.platform === 'darwin' || process.platform === 'linux') {
    await printViaCups(filePath, { printerName, color, duplex, staple, staplePlacement });
  } else if (process.platform === 'win32') {
    await printViaWindows(filePath, { printerName, color, duplex, staple, staplePlacement });
  } else {
    throw new Error(`Printing is not supported on platform "${process.platform}"`);
  }
}

// Maps the UI's staple placement labels to standard CUPS StapleLocation
// values. Actual support depends entirely on the selected printer's PPD/
// driver — CUPS will reject the option if the printer's finisher hardware
// doesn't advertise it, which we handle below by retrying without staple
// options rather than failing the whole job.
const STAPLE_LOCATION_MAP = {
  'Top-Left': 'UpperLeft',
  'Booklet Side': 'SaddleStitch',
  'Dual-Left': 'DualLeft',
};

// macOS / Linux: hand the file to CUPS directly via `lp`, the same system
// every native app (Preview, Acrobat, etc.) uses under the hood. This
// returns as soon as the job is queued — CUPS then handles delivery to the
// physical printer asynchronously, same as any other print submission.
//
// Option names below (sides, StapleLocation, print-color-mode) match a
// known-working configuration confirmed against the FollowMe printer PPD.
function printViaCups(filePath, { printerName, color, duplex, staple, staplePlacement }, { skipStaple = false } = {}) {
  return new Promise((resolve, reject) => {
    const args = ['-d', printerName];
    args.push('-o', duplex ? 'sides=two-sided-long-edge' : 'sides=one-sided');
    args.push('-o', `print-color-mode=${color ? 'color' : 'monochrome'}`);

    if (staple && !skipStaple) {
      const location = STAPLE_LOCATION_MAP[staplePlacement] || 'UpperLeft';
      args.push('-o', `StapleLocation=${location}`);
    }

    args.push(filePath);

    execFile('lp', args, (err, stdout, stderr) => {
      if (err) {
        const message = stderr?.toString().trim() || err.message;
        // If the failure looks like it's about the staple option specifically
        // and we haven't already retried, resubmit without it rather than
        // failing the whole print job over unsupported finisher hardware.
        if (staple && !skipStaple && /staple|finishing|unsupported|bad option/i.test(message)) {
          console.warn(`[print] Printer rejected staple option ("${message}"), retrying without it.`);
          printViaCups(filePath, { printerName, color, duplex, staple, staplePlacement }, { skipStaple: true })
              .then(resolve)
              .catch(reject);
          return;
        }
        reject(new Error(message));
      } else {
        resolve();
      }
    });
  });
}

// Windows has no built-in CLI PDF-print tool equivalent to `lp`. The
// reliable cross-platform approach is the `pdf-to-printer` package, which
// bundles SumatraPDF on Windows for silent printing and falls back to
// `lp`/`lpr` on macOS/Linux. Not wired up yet — see README for the
// dependency to add when Windows support is needed. Note: SumatraPDF's
// print-settings string also supports stapling on drivers that expose it
// (e.g. "-print-settings duplex,color,staple") once that path is built.
async function printViaWindows(_filePath, _opts) {
  throw new Error(
      'Windows printing isn\'t wired up yet in this build — see README for the pdf-to-printer setup needed.'
  );
}