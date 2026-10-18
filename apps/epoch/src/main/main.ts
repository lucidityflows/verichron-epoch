/// <reference types="@electron-forge/plugin-vite/forge-vite-env" />
import electron from 'electron';
import path from 'path';
import { Pool } from 'pg';
import type { BrowserWindowConstructorOptions, BrowserWindow as BrowserWindowType } from 'electron';
import { loadRootEnv, resolveDatabaseUrl } from '@verichron/contracts';
import { readerTypes } from '@verichron/etl-db-reader';
import { registerDbHandlers } from './ipc/dbHandlers';
import { registerReportHandlers } from './ipc/reportHandlers';
import { closeAbandonedRunsOnStartup, registerPipelineHandlers } from './ipc/pipelineHandlers';
import { registerDeviceHandlers } from './ipc/deviceHandlers';
import { addPopOut } from './windows';

const { app, BrowserWindow, ipcMain } = electron;

console.log('\n=======================================');
console.log('MAIN PROCESS IS EXECUTING!');
console.log('=======================================\n');

const REPO_ROOT = path.resolve(__dirname, '../../../..');
loadRootEnv(REPO_ROOT);

// Missing database configuration is fatal startup input, not a recoverable runtime exception.
const dbPool = new Pool({
  connectionString: resolveDatabaseUrl(),
  max: 10,
  types: readerTypes,
});

process.on('uncaughtException', (error) => {
  console.error('\n--- FATAL UNCAUGHT EXCEPTION ---');
  console.error(error);
  console.error('--------------------------------\n');
});

process.on('unhandledRejection', (reason) => {
  console.error('\n--- UNHANDLED PROMISE REJECTION ---');
  console.error(reason);
  console.error('-----------------------------------\n');
});

let mainWindow: BrowserWindowType | null = null;
const getMainWindow = () => mainWindow;

// Register all modularized IPC routes
registerDbHandlers(dbPool);
registerReportHandlers(dbPool);
// EPOCH-305, EPOCH-435: pipelineHandlers needs DB access too -- when the
// orchestrator subprocess it spawns crashes, times out, or is cancelled, it
// ends the runs that call created (closeCallRuns in pipelineHandlers.ts)
// rather than leaving them running forever.
const pipeline = registerPipelineHandlers(getMainWindow, REPO_ROOT, dbPool, app.getVersion());
registerDeviceHandlers(getMainWindow);

const webPreferences: BrowserWindowConstructorOptions['webPreferences'] = {
  preload: path.join(__dirname, 'preload.js'),
  contextIsolation: true,
  nodeIntegration: false,
};

/** Loads the renderer into a window; `hash` picks a view of its own, e.g. the Activity Log's pop-out. */
function loadRenderer(window: BrowserWindowType, hash?: string): void {
  if (typeof MAIN_WINDOW_VITE_DEV_SERVER_URL !== 'undefined') {
    const url = MAIN_WINDOW_VITE_DEV_SERVER_URL.replace('localhost', '127.0.0.1');
    window.loadURL(hash ? `${url}#${hash}` : url);
  } else if (typeof MAIN_WINDOW_VITE_NAME !== 'undefined') {
    window.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`), hash ? { hash } : {});
  } else {
    console.error('Vite target variables are missing.');
  }
}

let activityLogWindow: BrowserWindowType | null = null;

// EPOCH-570: the Activity Log in its own window, for a second monitor. It
// follows the same task as the drawer; one is open at a time.
ipcMain.handle('epoch:popOutActivityLog', () => {
  if (activityLogWindow && !activityLogWindow.isDestroyed()) {
    activityLogWindow.focus();
    return;
  }
  activityLogWindow = new BrowserWindow({ width: 1100, height: 640, title: 'Activity Log', webPreferences });
  addPopOut(activityLogWindow);
  activityLogWindow.on('closed', () => {
    activityLogWindow = null;
  });
  loadRenderer(activityLogWindow, 'activity-log');
});

const createWindow = (): void => {
  const windowOptions: BrowserWindowConstructorOptions = {
    width: 1400,
    height: 900,
    webPreferences,
  };

  mainWindow = new BrowserWindow(windowOptions);
  loadRenderer(mainWindow);

  if (!app.isPackaged) {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
};

app.whenReady().then(async () => {
  // EPOCH-435: closes runs whose orchestrator is gone before the window
  // opens and IPC becomes reachable, so a fresh launch never shows a run
  // left by the previous session as "in progress" even briefly.
  await closeAbandonedRunsOnStartup(dbPool);
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  }
});

app.on('before-quit', () => {
  // A running task is in a process group of its own and would outlive the app (EPOCH-570).
  pipeline.stopAll();
  dbPool.end().catch((err) => console.error('Error closing DB pool:', err));
});
