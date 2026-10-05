'use strict';

// munder-vault mount: only an agent with a resolved project mapping gets it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'md-vault-mount-'));
const electronPath = require.resolve('electron');
require.cache[electronPath] = {
  id: electronPath, filename: electronPath, loaded: true,
  exports: { app: { getPath: () => userData, isPackaged: false, getAppPath: () => path.join(__dirname, '..') } }
};
const { HiveManager } = loadTs('src/main/hive.ts');
test.after(() => fs.rmSync(userData, { recursive: true, force: true }));

const hive = new HiveManager(() => userData);
const script = path.join(__dirname, '..', 'resources', 'vault-mcp.cjs');
const mount = { root: '/v', scopes: ['01-Projects/Acme', '99-System', '03-Resources'], script };
const build = (vault, cfg = {}) => hive['buildDefaultMcpServers'](os.tmpdir(), cfg, 'jim-1', { provider: 'claude' }, undefined, vault);

test('no project mapping: no vault server (fail closed)', () => {
  assert.equal(build(undefined)['munder-vault'], undefined);
});

test('mapped project: server mounted with exactly its scope in env', () => {
  const s = build(mount)['munder-vault'];
  assert.deepEqual(s.args, [script]);
  assert.equal(s.env.VAULT_ROOT, '/v');
  assert.deepEqual(JSON.parse(s.env.VAULT_SCOPES), mount.scopes);
});

test('missing server script: not mounted', () => {
  assert.equal(build({ ...mount, script: '/nonexistent/vault-mcp.cjs' })['munder-vault'], undefined);
});

test('operator consent off: not mounted even with a mapping', () => {
  assert.equal(build(mount, { vault: { enabled: false } })['munder-vault'], undefined);
});

test('per-agent allow-list is honoured', () => {
  assert.equal(build(mount, { vault: { enabled: true, agents: ['someone-else'] } })['munder-vault'], undefined);
});
