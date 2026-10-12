/// <reference types="@electron-forge/plugin-vite/forge-vite-env" />
import electron from 'electron';
import path from 'path';
import { Pool } from 'pg';
import type { BrowserWindowConstructorOptions, BrowserWindow as BrowserWindowType } from 'electron';
import { loadRootEnv, resolveDatabaseUrl } from '@verichron/contracts';
import { registerDbHandlers } from './ipc/dbHandlers';
import { registerReportHandlers } from './ipc/reportHandlers';
import { registerPipelineHandlers, reconcileStaleRunsOnStartup } from './ipc/pipelineHandlers';
import { registerDeviceHandlers } from './ipc/deviceHandlers';

const { app, BrowserWindow } = electron;

console.log('\n=======================================');
console.log('MAIN PROCESS IS EXECUTING!');
console.log('=======================================\n');

const REPO_ROOT = path.resolve(__dirname, '../../../..');
loadRootEnv(REPO_ROOT);

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

const dbPool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'forensics',
  user: process.env.DB_USER || 'forensics',
  password: process.env.DB_PASSWORD || 'forensics_dev_only',
  connectionString: resolveDatabaseUrl(),
  max: 10,
});

let mainWindow: BrowserWindowType | null = null;
const getMainWindow = () => mainWindow;

// Register all modularized IPC routes
registerDbHandlers(dbPool);
registerReportHandlers(dbPool);
// EPOCH-305: pipelineHandlers now needs DB access too -- when the
// orchestrator subprocess it spawns crashes, times out, or is cancelled,
// it closes out any dangling pipeline_runs/pipeline_stage_status rows
// directly rather than leaving them stuck 'running' forever (see
// markWorkspaceRunsAborted in pipelineHandlers.ts).
registerPipelineHandlers(getMainWindow, REPO_ROOT, dbPool);
registerDeviceHandlers(getMainWindow);

const createWindow = (): void => {
  const windowOptions: BrowserWindowConstructorOptions = {
    width: 1400,
    height: 900,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  };

  mainWindow = new BrowserWindow(windowOptions);

  if (typeof MAIN_WINDOW_VITE_DEV_SERVER_URL !== 'undefined') {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL.replace('localhost', '127.0.0.1'));
  } else if (typeof MAIN_WINDOW_VITE_NAME !== 'undefined') {
    mainWindow.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
  } else {
    console.error('Vite target variables are missing.');
  }

  if (!app.isPackaged) {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
};

app.whenReady().then(async () => {
  // EPOCH-305 app-restart reconciliation: must complete before the window
  // opens and IPC becomes reachable, so a fresh launch never shows a run
  // left dangling by the previous session as "in progress" even briefly.
  await reconcileStaleRunsOnStartup(dbPool);
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
  dbPool.end().catch((err) => console.error('Error closing DB pool:', err));
});
