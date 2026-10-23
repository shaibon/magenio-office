'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'md-n8n-'));
const electronPath = require.resolve('electron');
require.cache[electronPath] = {
  id: electronPath, filename: electronPath, loaded: true,
  exports: { app: { getPath: () => userData, isPackaged: false, getAppPath: () => path.join(__dirname, '..') } }
};
test.after(() => fs.rmSync(userData, { recursive: true, force: true }));

const { HiveManager } = loadTs('src/main/hive.ts');
const { MCP_CATALOG, normalizeN8nUrl } = loadTs('src/shared/mcpCatalog.ts');
const { codexMcpServers, codexMcpToml } = loadTs('src/shared/codexMcp.ts');

const hive = new HiveManager(() => userData);
const ALL_OFF = Object.fromEntries(MCP_CATALOG.map((e) => [e.id, { enabled: false }]));
const URL_OK = 'https://n8n.example.com/mcp-server/http';
const TOKEN = 'tok-SECRET-123';
const cfg = (n8n) => ({ ...ALL_OFF, n8n });
const build = (c, id, provider = 'claude', token = TOKEN) =>
  hive['buildDefaultMcpServers'](userData, c, id, { provider }, undefined, undefined, undefined, token || undefined);

test('catalog: n8n is a non-safe, default-off remote entry', () => {
  const e = MCP_CATALOG.find((x) => x.id === 'n8n');
  assert.equal(e.remote, true);
  assert.notEqual(e.tier, 'safe-readonly');
  assert.equal(e.defaultEnabled, false);
});

test('normalizeN8nUrl: https only, http just for loopback, no userinfo', () => {
  assert.ok(normalizeN8nUrl(URL_OK));
  assert.ok(normalizeN8nUrl('http://localhost:5678/mcp-server/http'));
  for (const bad of ['', undefined, 'http://n8n.example.com/mcp-server/http', 'https://u:p@n8n.example.com/x', 'not a url'])
    assert.equal(normalizeN8nUrl(bad), null, String(bad));
});

test('not mounted without consent, URL, token, or an allow-list entry', () => {
  const on = { enabled: true, url: URL_OK, agents: ['jim'] };
  assert.equal(build(cfg({ ...on, enabled: false }), 'jim')['munder-n8n'], undefined, 'no consent');
  assert.equal(build(cfg({ ...on, url: '' }), 'jim')['munder-n8n'], undefined, 'no url');
  assert.equal(build(cfg({ ...on, url: 'http://evil.example.com/x' }), 'jim')['munder-n8n'], undefined, 'insecure url');
  assert.equal(build(cfg(on), 'jim', 'claude', '')['munder-n8n'], undefined, 'no token');
  assert.equal(build(cfg({ ...on, agents: [] }), 'jim')['munder-n8n'], undefined, 'empty list means nobody');
  assert.equal(build(cfg({ ...on, agents: undefined }), 'jim')['munder-n8n'], undefined, 'absent list means nobody');
  assert.equal(build(cfg({ ...on, agents: ['dwight'] }), 'jim')['munder-n8n'], undefined, 'not allow-listed');
});

test('mounted natively for allowed claude and codex agents', () => {
  const c = cfg({ enabled: true, url: URL_OK, agents: ['jim', 'dwight'] });
  const claude = build(c, 'jim')['munder-n8n'];
  assert.deepEqual(claude, { type: 'http', url: URL_OK, headers: { Authorization: `Bearer ${TOKEN}` } });
  const codex = hive['codexMcpTables']({ id: 'dwight', cwd: userData, provider: 'codex' }, { mcpDefaults: c, n8nToken: TOKEN });
  assert.match(codex, /\[mcp_servers\.munder-n8n\]\nurl = "https:\/\/n8n\.example\.com\/mcp-server\/http"/);
  assert.match(codex, /http_headers = \{ Authorization = "Bearer tok-SECRET-123" \}/);
  assert.match(codex, /default_tools_approval_mode = "approve"/);
});

test('the token is not in consent/config and not in any env block', () => {
  const c = cfg({ enabled: true, url: URL_OK, agents: ['jim'] });
  assert.ok(!JSON.stringify(c).includes(TOKEN));
  const m = build(c, 'jim');
  assert.ok(!('env' in m['munder-n8n']), 'no env: the token is not an env var of the agent or the server');
  assert.ok(codexMcpServers(m)['munder-n8n']);
  // Trade-off (documented): it IS in the per-agent mcp.json / config.toml, which are 0644 files in the agent dir.
  assert.ok(codexMcpToml(m).includes(TOKEN));
});
