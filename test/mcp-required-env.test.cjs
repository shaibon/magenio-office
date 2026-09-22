/**
 * t-067, point 3 — a catalog server whose required secret is still the catalog's
 * EMPTY placeholder is not mounted.
 *
 * The catalog spells a required secret as an empty string (`BRAVE_API_KEY: ''`,
 * `GITHUB_PERSONAL_ACCESS_TOKEN: ''`, …). Mounting one of those produces a server
 * that exits immediately with "<KEY> environment variable is required", which the
 * client shows as a server that never connects — reproduced live: god's
 * `munder-search-with-key` died on exactly that line, and the empty
 * `BRAVE_API_KEY` is why.
 *
 * The rule is generic (any catalog entry with an empty env value), so a future
 * keyed server inherits it for free. Note the consequence: `search-with-key`
 * cannot be mounted until there is a way to SUPPLY the key — which is the point,
 * since the alternative is a corpse on every spawn.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'md-mcp-env-'));
const electronPath = require.resolve('electron');
require.cache[electronPath] = {
  id: electronPath, filename: electronPath, loaded: true,
  exports: { app: { getPath: () => userData, isPackaged: false, getAppPath: () => path.join(__dirname, '..') } }
};

const { HiveManager } = loadTs('src/main/hive.ts');
const { MCP_CATALOG } = loadTs('src/shared/mcpCatalog.ts');

test.after(() => fs.rmSync(userData, { recursive: true, force: true }));

const hive = new HiveManager(() => userData);
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'md-mcp-cwd-'));
test.after(() => fs.rmSync(cwd, { recursive: true, force: true }));

function servers(cfg, agentId = 'jim-1') {
  return hive['buildDefaultMcpServers'](cwd, cfg, agentId, { provider: 'claude' });
}

test('a server whose required env is still the empty placeholder is not mounted', () => {
  const s = servers({ 'search-with-key': { enabled: true } });
  assert.equal(s['munder-search-with-key'], undefined);
});

test('the empty-secret rule holds for every keyed server, not just Brave', () => {
  const s = servers({ 'github-token': { enabled: true }, db: { enabled: true }, 'email-calendar': { enabled: true } });
  assert.equal(s['munder-github-token'], undefined);
  assert.equal(s['munder-db'], undefined);
  assert.equal(s['munder-email-calendar'], undefined);
});

test('a server with no secret at all is unaffected by the rule', () => {
  const s = servers({ 'sequential-thinking': { enabled: true }, fetch: { enabled: true } });
  assert.ok(s['munder-sequential-thinking']);
  assert.ok(s['munder-fetch']);
});

test('the rule is exactly "catalog entry with an empty env value"', () => {
  // Documents the contract the guard reads, so a catalog edit that adds a keyed
  // server without a placeholder is a deliberate change and not a silent pass.
  const keyed = MCP_CATALOG.filter((e) => Object.keys(e.spec.env ?? {}).length).map((e) => e.id);
  assert.ok(keyed.includes('search-with-key'));
  for (const id of keyed) {
    const entry = MCP_CATALOG.find((e) => e.id === id);
    const s = servers({ [id]: { enabled: true } });
    const allEmpty = Object.values(entry.spec.env).every((v) => !String(v).trim());
    assert.equal(s[`munder-${id}`] === undefined, allEmpty, `${id}: mounted iff its secret is configured`);
  }
});
