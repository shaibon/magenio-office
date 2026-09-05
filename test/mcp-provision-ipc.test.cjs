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
  const dest = mainSrc.slice(mainSrc.indexOf('function trelloMcpInstallDest'));
  assert.ok(dest.length > 0, 'the install destination must have a named derivation');
  assert.match(dest.slice(0, 300), /getPath\('userData'\)/, 'the destination must be derived in main, never taken from the renderer');
});

test('the install destination is derived exactly once, so the UI and the installer cannot disagree', () => {
  // mcp:presence reports this path so the button can SHOW it before the user
  // clicks, and mcp:install clones into it. Two copies of the expression would
  // let the UI promise a directory the installer does not use.
  const occurrences = mainSrc.split("join(app.getPath('userData'), 'mcp', 'trello')").length - 1;
  assert.equal(occurrences, 1, 'the trello install path must appear in exactly one place in main');

  const install = mainSrc.slice(mainSrc.indexOf("ipcMain.handle('mcp:install'"));
  assert.match(install.slice(0, 700), /trelloMcpInstallDest\(\)/, 'the installer must use the shared derivation');
  const presence = mainSrc.slice(mainSrc.indexOf("ipcMain.handle('mcp:presence'"));
  assert.match(presence.slice(0, 700), /trelloMcpInstallDest\(\)/, 'presence must report the shared derivation');
});

test('presence carries the install destination, and only for the entry that has an installer', () => {
  const presence = mainSrc.slice(mainSrc.indexOf("ipcMain.handle('mcp:presence'"), mainSrc.indexOf("ipcMain.handle('mcp:install'"));
  assert.match(presence, /installDest/, 'presence must return the destination for the UI to display');
  assert.match(presence, /p\.id === 'trello'/, 'only trello has an installer, so only trello gets a destination');
});

test('no new IPC channel was added for the destination', () => {
  assert.equal(/mcp:installDest|mcpInstallDest:/.test(mainSrc + preloadSrc), false, 'the destination rides on mcp:presence');
});

test('preload exposes both methods', () => {
  assert.match(preloadSrc, /mcpPresence:/);
  assert.match(preloadSrc, /mcpInstall:/);
});

test('preload types the optional install destination on the presence result', () => {
  const call = preloadSrc.slice(preloadSrc.indexOf('mcpPresence:'), preloadSrc.indexOf('mcpPresence:') + 260);
  assert.match(call, /installDest\?: string/);
});

test('the renderer cannot choose the install directory', () => {
  const call = preloadSrc.slice(preloadSrc.indexOf('mcpInstall:'), preloadSrc.indexOf('mcpInstall:') + 220);
  assert.equal(/destDir|path/.test(call), false, 'mcpInstall must take an id only');
  // Presence is a read: it takes an id and returns a path, never accepts one.
  const presenceCall = preloadSrc.slice(preloadSrc.indexOf('mcpPresence:'), preloadSrc.indexOf('mcpPresence:') + 260);
  assert.match(presenceCall, /invoke\('mcp:presence', \{ id \}\)/, 'mcpPresence must send an id and nothing else');
});
