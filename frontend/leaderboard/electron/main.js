'use strict';
const { app, BrowserWindow, screen, globalShortcut } = require('electron');
const path = require('path');
const fs   = require('fs');

const isDev = process.argv.includes('--dev');

// ── Load backend config ──────────────────────────────────────────────────────
// In dev:  reads  electron/config.json  (next to this file)
// In prod: reads  resources/config.json (extracted by electron-builder)
function loadConfig() {
  const candidates = [
    path.join(__dirname, 'config.json'),
    path.join(process.resourcesPath || '', 'config.json'),
  ];
  for (const p of candidates) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
    catch { /* try next */ }
  }
  return { backendUrl: 'http://localhost:3000' };
}

// ── Pick display ─────────────────────────────────────────────────────────────
// Prefer a secondary/external monitor so the leaderboard appears on the 4K screen
// while the operator uses the primary monitor for the control panel.
function getTargetDisplay() {
  const all = screen.getAllDisplays();
  const secondary = all.find(d => d.bounds.x !== 0 || d.bounds.y !== 0);
  return secondary || all[0];
}

// ── Create BrowserWindow ─────────────────────────────────────────────────────
function createWindow(backendUrl) {
  const { bounds } = getTargetDisplay();

  const win = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width:  bounds.width,
    height: bounds.height,
    fullscreen: true,
    frame: false,
    backgroundColor: '#06070c',
    title: 'Slot Tournament Leaderboard',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Pass the backend URL into the renderer via preload args
      additionalArguments: [`--backend-url=${backendUrl}`],
    },
  });

  if (isDev) {
    // Dev: Vite dev server handles hot-reload and API proxy
    win.loadURL('http://localhost:5174');
  } else {
    // Production: load the Vite-built static bundle
    win.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  // ── Keyboard shortcuts ───────────────────────────────────────────────────
  // F11  – toggle fullscreen / windowed
  globalShortcut.register('F11', () => win.setFullScreen(!win.isFullScreen()));
  // Escape – exit fullscreen (useful during config / setup)
  globalShortcut.register('Escape', () => {
    if (win.isFullScreen()) win.setFullScreen(false);
  });
  // F12  – DevTools (dev mode only)
  if (isDev) {
    globalShortcut.register('F12', () => win.webContents.toggleDevTools());
  }

  win.on('closed', () => app.quit());
}

// ── App lifecycle ────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  const { backendUrl } = loadConfig();
  console.log(`[Electron] Backend → ${backendUrl}`);
  createWindow(backendUrl);
});

app.on('window-all-closed', () => {
  globalShortcut.unregisterAll();
  app.quit();
});
