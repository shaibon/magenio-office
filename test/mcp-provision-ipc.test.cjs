'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'src/main/index.ts'), 'utf8');
const preloadSrc = fs.readFileSync(path.join(__dirname, '..', 'src/preload/index.ts'), 'utf8');

test('main registers the two provisioning handlers', () => {
  assert.match(mainSrc, /ipcMain\.handle\('mcp:presence'/);
  assert.match(mainSrc, /ipcMain\.handle\('mcp:install'/);
});

test('install is confined to the app userData directory', () => {
  const block = mainSrc.slice(mainSrc.indexOf("ipcMain.handle('mcp:install'"));
  assert.match(block.slice(0, 900), /getPath\('userData'\)/, 'the destination must be derived in main, never taken from the renderer');
});

test('preload exposes both methods', () => {
  assert.match(preloadSrc, /mcpPresence:/);
  assert.match(preloadSrc, /mcpInstall:/);
});

test('the renderer cannot choose the install directory', () => {
  const call = preloadSrc.slice(preloadSrc.indexOf('mcpInstall:'), preloadSrc.indexOf('mcpInstall:') + 220);
  assert.equal(/destDir|path/.test(call), false, 'mcpInstall must take an id only');
});
