'use strict';
// Preload runs with Node.js access before the renderer loads.
// It reads the --backend-url arg injected by main.js and exposes
// window.__config__ to the React app via contextBridge.
const { contextBridge } = require('electron');

const arg = process.argv.find(a => a.startsWith('--backend-url='));
const backendUrl = arg
  ? arg.slice('--backend-url='.length)
  : 'http://localhost:3000';

const fs2 = require('fs');
const path2 = require('path');
let cfg = {};
const cfgCandidates = [path2.join(__dirname, 'config.json'), path2.join(process.resourcesPath || '', 'config.json')];
for (const p of cfgCandidates) {
  try { cfg = JSON.parse(fs2.readFileSync(p, 'utf8')); break; } catch { /* next */ }
}

contextBridge.exposeInMainWorld('__config__', {
  backendUrl,
  backgroundImage: cfg.backgroundImage || './bg.jpg',
  // Per-background-image calibration (row/column pixel positions, timer
  // circle position/size) against the fixed 1920x1080 design canvas -- see
  // Leaderboard.tsx DEFAULT_ROW/COL_NAME/COL_WIN/TIMER for the shape and
  // measurement method. Omit any key (or the whole `layout` object) to keep
  // the built-in defaults; only override what a new background image needs
  // recalibrated. No rebuild required -- just edit this config.json.
  layout: cfg.layout || undefined,
});
