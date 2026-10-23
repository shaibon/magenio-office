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
const { MCP_CATALOG, normalizeN8nUrl, resolveN8nProject, migrateN8nConsent, n8nSecretRef } = loadTs('src/shared/mcpCatalog.ts');
const { codexMcpServers, codexMcpToml } = loadTs('src/shared/codexMcp.ts');

const hive = new HiveManager(() => userData);
const ALL_OFF = Object.fromEntries(MCP_CATALOG.map((e) => [e.id, { enabled: false }]));
const URL_OK = 'https://n8n.example.com/mcp-server/http';
const TOKEN = 'tok-SECRET-123';
const cfg = (n8n) => ({ ...ALL_OFF, n8n });
const BROKER_URL = 'http://127.0.0.1:4555/n8n-mcp';
const build = (c, id, provider = 'claude', brokerUrl = BROKER_URL, project = 'BURD') =>
  hive['buildDefaultMcpServers'](userData, c, id, { provider, project }, undefined, undefined, undefined, brokerUrl || undefined);

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

const entry = (o = {}) => ({ url: URL_OK, agents: ['jim'], ...o });
const on = (projects, enabled = true) => cfg({ enabled, projects });

test('not mounted without consent, URL, token/broker, project entry, or an allow-list entry', () => {
  assert.equal(build(on({ BURD: entry() }, false), 'jim')['munder-n8n'], undefined, 'no consent');
  assert.equal(build(on({ BURD: entry({ url: '' }) }), 'jim')['munder-n8n'], undefined, 'no url');
  assert.equal(build(on({ BURD: entry({ url: 'http://evil.example.com/x' }) }), 'jim')['munder-n8n'], undefined, 'insecure url');
  assert.equal(build(on({ BURD: entry() }), 'jim', 'claude', '')['munder-n8n'], undefined, 'no stored token / broker down');
  assert.equal(build(on({ BURD: entry({ agents: [] }) }), 'jim')['munder-n8n'], undefined, 'empty list means nobody');
  assert.equal(build(on({ BURD: entry({ agents: undefined }) }), 'jim')['munder-n8n'], undefined, 'absent list means nobody');
  assert.equal(build(on({ BURD: entry({ agents: ['dwight'] }) }), 'jim')['munder-n8n'], undefined, 'not allow-listed');
  assert.equal(build(on({}), 'jim')['munder-n8n'], undefined, 'project has no entry');
  assert.equal(build(on({ BURD: entry() }), 'jim', 'claude', BROKER_URL, null)['munder-n8n'], undefined, 'agent without a project');
  assert.equal(build(cfg({ enabled: true, url: URL_OK, agents: ['jim'] }), 'jim')['munder-n8n'], undefined, 'legacy global config mounts nothing');
});

test('isolation: an agent only gets n8n for its own project, and only if listed there', () => {
  const c = on({ BURD: entry({ agents: ['jim'] }), RISTO: entry({ url: 'https://risto.example.com/mcp', agents: ['dwight'] }) });
  assert.ok(build(c, 'jim', 'claude', BROKER_URL, 'BURD')['munder-n8n']);
  assert.equal(build(c, 'jim', 'claude', BROKER_URL, 'RISTO')['munder-n8n'], undefined, 'jim is not on RISTO list');
  assert.equal(build(c, 'dwight', 'claude', BROKER_URL, 'BURD')['munder-n8n'], undefined, 'dwight is not on BURD list');
  assert.equal(build(c, 'jim', 'claude', BROKER_URL, '__proto__')['munder-n8n'], undefined, 'prototype keys are not projects');
  assert.equal(resolveN8nProject(c.n8n, 'RISTO', 'dwight').url, 'https://risto.example.com/mcp');
  assert.equal(resolveN8nProject(c.n8n, 'BURD', 'dwight'), null);
  assert.equal(n8nSecretRef('BURD'), 'mcp:n8n:BURD');
});

test('mounted on the broker route for allowed claude and codex agents; no secret in any config', () => {
  const c = on({ BURD: entry({ agents: ['jim', 'dwight'] }) });
  const claude = build(c, 'jim')['munder-n8n'];
  assert.deepEqual(claude, { type: 'http', url: BROKER_URL, headers: { 'X-MD-Broker-Token': '${MD_N8N_MCP_TOKEN}' } });
  const codex = hive['codexMcpTables']({ id: 'dwight', cwd: userData, provider: 'codex', project: 'BURD' }, { mcpDefaults: c, n8nBrokerUrl: BROKER_URL });
  assert.match(codex, /\[mcp_servers\.munder-n8n\]\nurl = "http:\/\/127\.0\.0\.1:4555\/n8n-mcp"/);
  assert.match(codex, /env_http_headers = \{ X-MD-Broker-Token = "MD_N8N_MCP_TOKEN" \}/);
  assert.doesNotMatch(codex, /^http_headers/m, 'no literal header value');
  assert.match(codex, /default_tools_approval_mode = "approve"/);
  for (const text of [JSON.stringify(c), JSON.stringify(claude), codex]) {
    assert.ok(!text.includes(TOKEN) && !text.includes('Bearer'), 'no bearer on disk');
  }
  for (const text of [JSON.stringify(claude), codex]) assert.ok(!text.includes('n8n.example.com'), 'the n8n host is not in the agent config either');
});

test('migration: legacy global config becomes per-project entries by registry project', () => {
  const projectOf = (id) => ({ jim: 'BURD', pam: 'BURD', dwight: 'RISTO', ghost: undefined })[id];
  const m = migrateN8nConsent({ enabled: true, url: URL_OK, agents: ['jim', 'pam', 'dwight', 'ghost'] }, projectOf);
  assert.deepEqual(m.consent, { enabled: true, projects: { BURD: { url: URL_OK, agents: ['jim', 'pam'] }, RISTO: { url: URL_OK, agents: ['dwight'] } } });
  assert.deepEqual(m.projects.sort(), ['BURD', 'RISTO']);
  assert.ok(!('url' in m.consent) && !('agents' in m.consent), 'no global endpoint left');
  assert.deepEqual(migrateN8nConsent({ enabled: true, url: '', agents: [] }, projectOf).consent, { enabled: true, projects: {} }, 'empty legacy is dropped');
  assert.equal(migrateN8nConsent({ enabled: true, projects: { A: entry() } }, projectOf), null, 'already per-project: nothing to do');
  assert.equal(migrateN8nConsent(undefined, projectOf), null);
});

test('per-agent config files are written 0600', () => {
  const p = path.join(userData, 'cfg.json');
  hive['writeJson'](p, { a: 1 });
  fs.chmodSync(p, 0o644);
  hive['writeJson'](p, { a: 2 });
  assert.equal(fs.statSync(p).mode & 0o777, 0o600);
});

test('broker: n8n-only capability proxies /n8n-mcp, adds the bearer, reaches nothing else', async () => {
  const http = require('node:http');
  const { IntegrationBroker } = loadTs('src/main/integrationBroker.ts');
  let seen;
  const up = http.createServer((req, res) => { seen = req.headers; res.end('{"ok":true}'); });
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  const upUrl = `http://127.0.0.1:${up.address().port}/mcp-server/http`;
  let seenB;
  const upB = http.createServer((req, res) => { seenB = req.headers; res.end('{"ok":"B"}'); });
  await new Promise((r) => upB.listen(0, '127.0.0.1', r));
  const upUrlB = `http://127.0.0.1:${upB.address().port}/mcp-server/http`;
  const TOKEN_B = 'tok-B-456';
  let allowed = ['jim'];
  const broker = new IntegrationBroker({
    getRecord: () => undefined, getSecret: () => undefined,
    n8nUpstream: (id, project) => (allowed.includes(id) ? { url: project === 'BURD' ? upUrl : upUrlB, token: project === 'BURD' ? TOKEN : TOKEN_B } : undefined),
    automations: { list: () => [], save: () => {}, agents: () => [] }
  });
  await broker.start();
  const call = (p, token, method = 'POST') => fetch(broker.url() + p, { method, headers: { 'x-md-broker-token': token, authorization: 'Bearer agent-supplied' }, body: method === 'POST' ? '{}' : undefined });
  try {
    const tok = broker.grantN8n('jim', 'BURD');
    const ok = await call('/n8n-mcp', tok);
    assert.equal(ok.status, 200);
    assert.equal(seen.authorization, `Bearer ${TOKEN}`, 'broker injects the bearer, agent-supplied auth is dropped');
    assert.equal(seen['x-md-broker-token'], undefined);
    assert.equal(seenB, undefined, 'a BURD capability never reaches project B');
    const tokB = broker.grantN8n('dwight', 'RISTO');
    allowed = ['jim', 'dwight'];
    assert.equal((await call('/n8n-mcp', tokB)).status, 200);
    assert.equal(seenB.authorization, `Bearer ${TOKEN_B}`, 'RISTO capability gets RISTO bearer');
    assert.equal(seen.authorization, `Bearer ${TOKEN}`, 'and BURD upstream untouched');
    allowed = ['jim'];
    assert.equal((await call('/automations', tok, 'GET')).status, 403, 'n8n capability opens no other route');
    const general = broker.grant('jim', []);
    assert.equal((await call('/n8n-mcp', general)).status, 403, 'a general capability is not an n8n capability');
    allowed = [];
    assert.equal((await call('/n8n-mcp', tok)).status, 403, 'allow-list is re-checked per request');
    allowed = ['jim'];
    broker.revoke('jim');
    assert.equal((await call('/n8n-mcp', tok)).status, 401, 'revoke drops the n8n capability too');
  } finally {
    broker.stop();
    up.close();
    upB.close();
  }
});

test('P1 regression: an empty token save never deletes the stored token; clearing is explicit', () => {
  const idx = fs.readFileSync(path.join(__dirname, '..', 'src/main/index.ts'), 'utf8');
  const set = /ipcMain\.handle\('mcp:n8nSetToken'[\s\S]*?\n\}\);/.exec(idx)[0];
  assert.doesNotMatch(set, /deleteSecret/, 'set handler must not delete');
  assert.match(set, /if \(!token\) return \{ ok: true \}/);
  assert.match(idx, /ipcMain\.handle\('mcp:n8nClearToken'.*deleteSecret\(n8nSecretRef\(project\)\)/);
  const ui = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/src/components/McpDefaultsSettings.tsx'), 'utf8');
  assert.match(ui, /if \(!token\.trim\(\)\) return;/, 'empty blur is a no-op in the renderer too');
});

test('an n8n-only capability is not a writable capability (Slack /alert guard)', () => {
  const { IntegrationBroker } = loadTs('src/main/integrationBroker.ts');
  const b = new IntegrationBroker({ getRecord: () => undefined, getSecret: () => undefined });
  assert.equal(b.hasWritableCapability(b.grantN8n('ordinary-agent')), false);
  assert.equal(b.hasWritableCapability(b.grant('god', [])), true);
});
