'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'md-mcp-scope-'));
const electronPath = require.resolve('electron');
require.cache[electronPath] = {
  id: electronPath, filename: electronPath, loaded: true,
  exports: { app: { getPath: () => userData, isPackaged: false, getAppPath: () => path.join(__dirname, '..') } }
};

const { HiveManager } = loadTs('src/main/hive.ts');

test.after(() => fs.rmSync(userData, { recursive: true, force: true }));

const hive = new HiveManager(() => userData);
const cwd = '/tmp/agent-cwd';

// `buildDefaultMcpServers` is private in TypeScript only — at run time it is a
// plain method, and calling it directly is far more precise than reconstructing
// a whole spawn just to read one block of the settings file.
function build(cfg, agentId) {
  return hive['buildDefaultMcpServers'](cwd, cfg, agentId);
}

/** A fully installed, credentialed Trello server on disk, so the preflight passes. */
function installedTrello() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'md-mcp-pkg-'));
  fs.mkdirSync(path.join(root, 'build'));
  fs.writeFileSync(path.join(root, 'build', 'index.js'), '// server');
  fs.writeFileSync(path.join(root, '.env'), 'TRELLO_API_KEY=k\nTRELLO_TOKEN=t\n');
  const command = path.join(root, 'bun');
  fs.writeFileSync(command, '#!/bin/sh\n');
  fs.chmodSync(command, 0o755);
  return { command, args: [path.join(root, 'build', 'index.js')] };
}

test('an unscoped consent still reaches every agent (regression)', () => {
  const cfg = { 'sequential-thinking': { enabled: true } };
  assert.ok(build(cfg, 'god')['munder-sequential-thinking']);
  assert.ok(build(cfg, 'worker-1')['munder-sequential-thinking']);
});

test('an agents-scoped consent reaches only the listed agents', () => {
  const { command, args } = installedTrello();
  const cfg = { trello: { enabled: true, agents: ['god'], command, args } };
  assert.ok(build(cfg, 'god')['munder-trello'], 'god should receive the scoped server');
  assert.equal(build(cfg, 'worker-1')['munder-trello'], undefined, 'a worker must not receive it');
});

test('an empty agents list means every agent, not none', () => {
  const { command, args } = installedTrello();
  const cfg = { trello: { enabled: true, agents: [], command, args } };
  assert.ok(build(cfg, 'worker-1')['munder-trello']);
});

test('a userConfigured entry uses the consent command and args', () => {
  const { command, args } = installedTrello();
  const cfg = { trello: { enabled: true, command, args } };
  const server = build(cfg, 'god')['munder-trello'];
  assert.equal(server.command, command);
  assert.deepEqual(server.args, args);
});

test('a userConfigured entry with no command is omitted, not written broken', () => {
  const cfg = { trello: { enabled: true } };
  assert.equal(build(cfg, 'god')['munder-trello'], undefined);
});

test('a userConfigured entry that fails its preflight is omitted', () => {
  const { command } = installedTrello();
  const cfg = { trello: { enabled: true, command, args: ['/nowhere/build/index.js'] } };
  assert.equal(build(cfg, 'god')['munder-trello'], undefined);
});

test('a command override is ignored for an entry that is not userConfigured', () => {
  const cfg = { 'sequential-thinking': { enabled: true, command: '/bin/evil', args: ['x'] } };
  const server = build(cfg, 'god')['munder-sequential-thinking'];
  assert.equal(server.command, 'npx', 'a hand-edited config must not swap a catalog server binary');
});
