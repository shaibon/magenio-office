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
  exports: {
    app: { getPath: () => userData, isPackaged: false, getAppPath: () => path.join(__dirname, '..') },
    safeStorage: { isEncryptionAvailable: () => true, encryptString: (t) => Buffer.from(t), decryptString: (b) => b.toString() }
  }
};
test.after(() => fs.rmSync(userData, { recursive: true, force: true }));

const { HiveManager } = loadTs('src/main/hive.ts');
const { MCP_CATALOG, normalizeN8nUrl, resolveN8nProject, migrateN8nConsent, runN8nMigration, createConsentWriter, n8nProjectOps, removeN8nProjectFlow, isN8nProjectKey, n8nSecretRef, N8N_LEGACY_SECRET_REF } = loadTs('src/shared/mcpCatalog.ts');
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
  assert.match(idx, /ipcMain\.handle\('mcp:n8nClearToken'[^]*?deleteSecret\(n8nSecretRef\(project\)\)/);
  const ui = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/src/components/McpDefaultsSettings.tsx'), 'utf8');
  assert.match(ui, /if \(!token\.trim\(\)\) return;/, 'empty blur is a no-op in the renderer too');
});

test('an n8n-only capability is not a writable capability (Slack /alert guard)', () => {
  const { IntegrationBroker } = loadTs('src/main/integrationBroker.ts');
  const b = new IntegrationBroker({ getRecord: () => undefined, getSecret: () => undefined });
  assert.equal(b.hasWritableCapability(b.grantN8n('ordinary-agent')), false);
  assert.equal(b.hasWritableCapability(b.grant('god', [])), true);
});

// ── QA t-232 fixes ──────────────────────────────────────────────────────────
function fakeStore(seed = {}, { failSet = [], failDelete = [] } = {}) {
  const m = new Map(Object.entries(seed));
  const log = [];
  return {
    m, log,
    getLegacy: () => m.get(N8N_LEGACY_SECRET_REF),
    hasSecret: (r) => m.has(r),
    setSecret: (r, v) => { log.push(`set:${r}`); if (failSet.includes(r)) return { ok: false }; m.set(r, v); return { ok: true }; },
    deleteSecret: (r) => { log.push(`del:${r}`); if (failDelete.includes(r)) return false; m.delete(r); return true; }
  };
}
const legacyConsent = () => ({ enabled: true, url: URL_OK, agents: ['jim', 'dwight'] });
const projOf = (id) => ({ jim: 'BURD', dwight: 'RISTO' })[id];

test('migration: success writes config, then deletes the legacy secret last', () => {
  const st = fakeStore({ [N8N_LEGACY_SECRET_REF]: TOKEN });
  const order = [];
  const r = runN8nMigration({ consent: legacyConsent(), projectOf: projOf, ...st, writeConsent: () => order.push('write') });
  assert.equal(r.migrated, true);
  assert.equal(st.m.get('mcp:n8n:BURD'), TOKEN);
  assert.equal(st.m.get('mcp:n8n:RISTO'), TOKEN);
  assert.equal(st.m.has(N8N_LEGACY_SECRET_REF), false);
  assert.deepEqual(order, ['write']);
  assert.equal(st.log.at(-1), `del:${N8N_LEGACY_SECRET_REF}`, 'legacy deleted only after everything else');
});

test('migration: a failed setSecret leaves everything as it was (legacy kept, new secrets rolled back, no config write)', () => {
  const st = fakeStore({ [N8N_LEGACY_SECRET_REF]: TOKEN }, { failSet: ['mcp:n8n:RISTO'] });
  let wrote = false;
  assert.throws(() => runN8nMigration({ consent: legacyConsent(), projectOf: projOf, ...st, writeConsent: () => { wrote = true; } }), /could not store the n8n token for/);
  assert.equal(wrote, false);
  assert.equal(st.m.get(N8N_LEGACY_SECRET_REF), TOKEN, 'legacy bearer preserved');
  assert.equal(st.m.has('mcp:n8n:BURD'), false, 'partial copies rolled back');
});

test('migration: a failed config write keeps the legacy secret and rolls the copies back', () => {
  const st = fakeStore({ [N8N_LEGACY_SECRET_REF]: TOKEN });
  assert.throws(() => runN8nMigration({ consent: legacyConsent(), projectOf: projOf, ...st, writeConsent: () => { throw new Error('disk full'); } }), /disk full/);
  assert.equal(st.m.get(N8N_LEGACY_SECRET_REF), TOKEN);
  assert.equal(st.m.has('mcp:n8n:BURD') || st.m.has('mcp:n8n:RISTO'), false);
});

test('migration: retry after a failure succeeds', () => {
  const st = fakeStore({ [N8N_LEGACY_SECRET_REF]: TOKEN });
  assert.throws(() => runN8nMigration({ consent: legacyConsent(), projectOf: projOf, ...st, writeConsent: () => { throw new Error('x'); } }), /^Error: x$/);
  assert.equal(runN8nMigration({ consent: legacyConsent(), projectOf: projOf, ...st, writeConsent: () => {} }).migrated, true);
  assert.equal(st.m.has(N8N_LEGACY_SECRET_REF), false);
});

test('prototype-name project keys are rejected everywhere', () => {
  for (const k of ['constructor', 'toString', 'hasOwnProperty', '__proto__', 'valueOf'])
    assert.equal(isN8nProjectKey(k), false, k);
  assert.equal(isN8nProjectKey('BURD'), true);
  const m = migrateN8nConsent({ enabled: true, url: URL_OK, agents: ['jim'] }, () => 'constructor');
  assert.deepEqual(m.projects, [], 'agent of a prototype-named project is dropped, not mis-placed');
  assert.deepEqual(m.consent.projects, {});
  assert.equal(resolveN8nProject({ enabled: true, projects: {} }, 'constructor', 'jim'), null);
});

test('Clear: deleteSecret reports failure when the last secret file cannot be removed', () => {
  const { setSecret, hasSecret, deleteSecret } = loadTs('src/main/integrations.ts');
  assert.equal(setSecret('mcp:n8n:CLR', TOKEN).ok, true);
  assert.equal(hasSecret('mcp:n8n:CLR'), true);
  fs.chmodSync(userData, 0o500); // directory not writable: the secrets file cannot be unlinked
  try {
    if (process.getuid && process.getuid() !== 0) {
      assert.equal(deleteSecret('mcp:n8n:CLR'), false, 'failure is observable');
      assert.equal(hasSecret('mcp:n8n:CLR'), true, 'and the secret really is still there');
    }
  } finally { fs.chmodSync(userData, 0o700); }
  assert.equal(deleteSecret('mcp:n8n:CLR'), true);
  assert.equal(hasSecret('mcp:n8n:CLR'), false);
});

test('Clear IPC and Settings only report success on a verified deletion; Remove is failure-aware', () => {
  const idx = fs.readFileSync(path.join(__dirname, '..', 'src/main/index.ts'), 'utf8');
  const clear = /ipcMain\.handle\('mcp:n8nClearToken'[\s\S]*?\n\}\);/.exec(idx)[0];
  assert.match(clear, /ok: integrations\.deleteSecret\(/);
  assert.match(clear, /catch \{ return \{ ok: false \}/);
  const ui = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/src/components/McpDefaultsSettings.tsx'), 'utf8');
  assert.match(ui, /if \(!\(await window\.cth\.mcpN8nClearToken\(project\)\)\.ok\) throw/);
  // Remove ordering/rollback is covered behaviorally by the createConsentWriter tests below.
  assert.match(ui, /removeN8nProjectFlow\(project, \(\) => clearN8nToken\(project\)/);
  assert.doesNotMatch(ui, /upsert\(project, kept\)/, 'no rollback');
});

// ── QA t-232 re-QA fixes ────────────────────────────────────────────────────
test('migration: a stored but undecryptable legacy token blocks migration and keeps the global config', () => {
  const st = fakeStore({ [N8N_LEGACY_SECRET_REF]: TOKEN });
  st.getLegacy = () => undefined; // safeStorage unavailable
  let wrote = false;
  assert.throws(() => runN8nMigration({ consent: legacyConsent(), projectOf: projOf, ...st, writeConsent: () => { wrote = true; } }), /cannot be read/);
  assert.equal(wrote, false);
  assert.equal(st.m.has('mcp:n8n:BURD'), false);
  st.getLegacy = () => st.m.get(N8N_LEGACY_SECRET_REF); // decryption back: migrates
  assert.equal(runN8nMigration({ consent: legacyConsent(), projectOf: projOf, ...st, writeConsent: () => {} }).migrated, true);
  assert.equal(st.m.get('mcp:n8n:BURD'), TOKEN);
});

test('migration: no legacy secret at all still migrates the config (nothing to copy)', () => {
  const st = fakeStore();
  assert.equal(runN8nMigration({ consent: legacyConsent(), projectOf: projOf, ...st, writeConsent: () => {} }).migrated, true);
});

test('migration: a failed legacy cleanup is retried at the next start even though the config is already migrated', () => {
  const st = fakeStore({ [N8N_LEGACY_SECRET_REF]: TOKEN });
  let cfgNow = legacyConsent();
  const run = () => runN8nMigration({ consent: cfgNow, projectOf: projOf, ...st, writeConsent: (c) => { cfgNow = c; } });
  const realDel = st.deleteSecret;
  st.deleteSecret = (r) => (r === N8N_LEGACY_SECRET_REF ? false : realDel(r));
  assert.throws(run, /legacy n8n token could not be removed/);
  assert.equal(st.m.has(N8N_LEGACY_SECRET_REF), true);
  assert.equal(cfgNow.url, undefined, 'config already migrated');
  assert.throws(run, /legacy n8n token could not be removed/, 'still retried while deletion fails');
  st.deleteSecret = realDel;
  assert.equal(run().migrated, false);
  assert.equal(st.m.has(N8N_LEGACY_SECRET_REF), false, 'cleaned up on retry');
  assert.equal(st.m.get('mcp:n8n:BURD'), TOKEN);
});

test('Clear: an unreadable secret store is not "no secrets" (deleteSecret throws, hasSecret does not say absent)', () => {
  const { setSecret, hasSecret, deleteSecret } = loadTs('src/main/integrations.ts');
  assert.equal(setSecret('mcp:n8n:UNR', TOKEN).ok, true);
  const f = path.join(userData, 'integration-secrets.json');
  fs.chmodSync(f, 0o000);
  try {
    if (process.getuid && process.getuid() !== 0) {
      assert.throws(() => deleteSecret('mcp:n8n:UNR'), /EACCES/);
      assert.equal(hasSecret('mcp:n8n:UNR'), true, 'never claims absent');
    }
  } finally { fs.chmodSync(f, 0o600); }
  assert.equal(hasSecret('mcp:n8n:UNR'), true);
  assert.equal(deleteSecret('mcp:n8n:UNR'), true);
});

test('Settings writer: a rejected write does not leak into the next edit (rejected Remove, then another edit)', async () => {
  const entryA = { url: URL_OK, agents: ['jim'] };
  const ref = { current: { n8n: { enabled: true, projects: { BURD: entryA, RISTO: entryA } } } };
  const saved = [];
  let fail = true;
  const write = createConsentWriter(ref, async (next) => { if (fail) throw new Error('disk'); saved.push(next); });
  // Remove RISTO: the config write is rejected.
  await assert.rejects(write('n8n', { projects: { BURD: entryA } }), /disk/);
  assert.deepEqual(Object.keys(ref.current.n8n.projects).sort(), ['BURD', 'RISTO'], 'ref restored');
  // Another consent edit now must still carry RISTO.
  fail = false;
  await write('n8n', { enabled: true });
  assert.deepEqual(Object.keys(saved.at(-1).n8n.projects).sort(), ['BURD', 'RISTO'], 'project not lost');
  // Successful writes stack and stay ordered.
  await Promise.all([write('n8n', { projects: { BURD: entryA } }), write('n8n', { enabled: false })]);
  assert.deepEqual(Object.keys(saved.at(-1).n8n.projects), ['BURD']);
  assert.equal(saved.at(-1).n8n.enabled, false);
});

// ── QA3 ─────────────────────────────────────────────────────────────────────
test('Settings writer: an edit queued BEHIND a rejected Remove does not persist it (Toby case)', async () => {
  const entryA = { url: URL_OK, agents: ['jim'] };
  const ref = { current: { n8n: { enabled: true, projects: { A: entryA, B: entryA } } } };
  const saved = [];
  let calls = 0;
  const write = createConsentWriter(ref, async (next) => { if (calls++ === 0) throw new Error('disk'); saved.push(next); });
  const p1 = write('n8n', { projects: { A: entryA } }); // remove B: rejected
  const p2 = write('n8n', { enabled: false });          // queued before the rejection
  await assert.rejects(p1, /disk/);
  await p2;
  assert.deepEqual(Object.keys(saved.at(-1).n8n.projects).sort(), ['A', 'B'], 'on disk B is still there');
  assert.equal(saved.at(-1).n8n.enabled, false, 'the later edit still applied');
  assert.deepEqual(Object.keys(ref.current.n8n.projects).sort(), ['A', 'B'], 'and in the ref');
  assert.equal(ref.current.n8n.enabled, false);
});

test('removeRecord: config first; a failed secret removal restores the record; a failed config write keeps the secret', () => {
  const ints = loadTs('src/main/integrations.ts');
  const cfgMod = loadTs('src/main/config.ts');
  const rec = { id: 'rr-test', label: 'RR', kind: 'http', authType: 'bearer', baseUrl: 'https://rr.example.com', secretRef: loadTs('src/shared/integrations.ts').secretRefFor('rr-test'), enabled: true, createdAt: 1, updatedAt: 1 };
  cfgMod.writeConfig({ integrations: [rec] });
  assert.equal(ints.setSecret(rec.secretRef, 'x').ok, true);
  // 1) secret store unreadable -> deletion fails -> record restored, ok:false
  const f = path.join(userData, 'integration-secrets.json');
  if (process.getuid && process.getuid() !== 0) {
    fs.chmodSync(f, 0o000);
    try {
      const r = ints.removeRecord('rr-test');
      assert.equal(r.ok, false);
      assert.deepEqual(ints.listRecords().map((x) => x.id), ['rr-test'], 'record restored');
    } finally { fs.chmodSync(f, 0o600); }
    // 2) config write fails -> throws before the secret is touched
    fs.chmodSync(userData, 0o500);
    try {
      assert.throws(() => ints.removeRecord('rr-test'));
    } finally { fs.chmodSync(userData, 0o700); }
    assert.equal(ints.hasSecret(rec.secretRef), true, 'credential still there');
    assert.deepEqual(ints.listRecords().map((x) => x.id), ['rr-test']);
  }
  // 3) happy path
  assert.deepEqual(ints.removeRecord('rr-test'), { ok: true });
  assert.equal(ints.hasSecret(rec.secretRef), false);
  assert.deepEqual(ints.listRecords(), []);
});

// ── QA4: semantic n8n ops, queue race closed ────────────────────────────────
test('Settings writer: rejected middle write never loses or resurrects a project (Toby final case + variants)', async () => {
  const E = { url: URL_OK, agents: ['jim'] };
  const mk = (failAt) => {
    const ref = { current: { n8n: { enabled: true, projects: { A: E, B: E } } } };
    const saved = [];
    let n = 0;
    const write = createConsentWriter(ref, async (next) => { if (n++ === failAt) throw new Error('disk'); saved.push(next); });
    return { ref, saved, write };
  };
  const keys = (d) => Object.keys(d.n8n.projects).sort().join('');
  // enabled ok, Remove B rejected, Add C queued -> A,B,C
  let t = mk(1);
  const r = [t.write('n8n', { enabled: true }), t.write('n8n', n8nProjectOps.remove('B')), t.write('n8n', n8nProjectOps.upsert('C', E))];
  const res = await Promise.allSettled(r);
  assert.deepEqual(res.map((x) => x.status), ['fulfilled', 'rejected', 'fulfilled']);
  assert.equal(keys(t.saved.at(-1)), 'ABC');
  assert.equal(keys(t.ref.current), 'ABC');
  // Remove B rejected, Edit B queued -> B kept with the edit
  t = mk(0);
  await Promise.allSettled([t.write('n8n', n8nProjectOps.remove('B')), t.write('n8n', n8nProjectOps.upsert('B', { url: 'https://b2.example.com/mcp' }))]);
  assert.equal(t.saved.at(-1).n8n.projects.B.url, 'https://b2.example.com/mcp');
  assert.equal(keys(t.saved.at(-1)), 'AB');
  // Edit B rejected, Remove B queued -> B gone, nothing resurrected
  t = mk(0);
  await Promise.allSettled([t.write('n8n', n8nProjectOps.upsert('B', { url: 'https://b2.example.com/mcp' })), t.write('n8n', n8nProjectOps.remove('B'))]);
  assert.equal(keys(t.saved.at(-1)), 'A');
  assert.equal(keys(t.ref.current), 'A');
  // all succeed: ordered, semantic ops stack
  t = mk(-1);
  await Promise.all([t.write('n8n', n8nProjectOps.remove('B')), t.write('n8n', n8nProjectOps.upsert('C', E))]);
  assert.equal(keys(t.saved.at(-1)), 'AC');
});

// ── QA5: Remove = verified Clear first, no rollback ─────────────────────────
test('Remove: Clear failure leaves config intact; Clear ok + rejected remove leaves a token-less (non-mounting) entry; queued Edit is not overwritten', async () => {
  const E = { url: URL_OK, agents: ['jim'] };
  const mk = (failWrite) => {
    const ref = { current: { n8n: { enabled: true, projects: { A: E, B: E } } } };
    const saved = [];
    const write = createConsentWriter(ref, async (next) => { if (failWrite) throw new Error('disk'); saved.push(next); });
    return { ref, saved, write: (p) => write('n8n', p) };
  };
  // Clear fails -> abort, nothing written
  let t = mk(false);
  assert.equal(await removeN8nProjectFlow('B', async () => false, t.write), false);
  assert.equal(t.saved.length, 0);
  assert.deepEqual(Object.keys(t.ref.current.n8n.projects).sort(), ['A', 'B']);
  // Clear ok, config write rejected -> entry stays, but without a token it does not mount
  t = mk(true);
  assert.equal(await removeN8nProjectFlow('B', async () => true, t.write), false);
  assert.ok(t.ref.current.n8n.projects.B, 'entry left in place');
  assert.equal(build(t.ref.current.n8n && { ...ALL_OFF, n8n: t.ref.current.n8n }, 'jim', 'claude', '')['munder-n8n'], undefined, 'no token/broker route -> no mount');
  // Toby: Remove's write rejected while an Edit is queued behind it -> the Edit survives, nothing overwrites it
  const ref = { current: { n8n: { enabled: true, projects: { A: E, B: E } } } };
  const saved = []; let n = 0;
  const w = createConsentWriter(ref, async (next) => { if (n++ === 0) { await new Promise((r) => setTimeout(r, 20)); throw new Error('disk'); } saved.push(next); });
  const rm = removeN8nProjectFlow('B', async () => true, (p) => w('n8n', p));
  await new Promise((r) => setTimeout(r, 5)); // Remove's write is now in flight (and will reject)
  const edit = w('n8n', n8nProjectOps.upsert('B', { url: 'https://b2.example.com/mcp' }));
  assert.equal(await rm, false);
  await edit;
  assert.equal(saved.at(-1).n8n.projects.B.url, 'https://b2.example.com/mcp', 'queued edit persisted, not overwritten');
  // Success path
  t = mk(false);
  assert.equal(await removeN8nProjectFlow('B', async () => true, t.write), true);
  assert.deepEqual(Object.keys(t.saved.at(-1).n8n.projects), ['A']);
});

test('classifyN8nTokenCheck: valid only for a 2xx carrying an initialize result; 401/403 invalid; rest unreachable', () => {
  const { classifyN8nTokenCheck } = loadTs('src/shared/mcpCatalog.ts');
  const ok = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-03-26', capabilities: {} } });
  assert.equal(classifyN8nTokenCheck(200, ok), 'valid');
  assert.equal(classifyN8nTokenCheck(200, `event: message\ndata: ${ok}\n\n`), 'valid');
  assert.equal(classifyN8nTokenCheck(200, '<html>login</html>'), 'unreachable');
  assert.equal(classifyN8nTokenCheck(200, JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'x' } })), 'unreachable');
  assert.equal(classifyN8nTokenCheck(200), 'unreachable');
  for (const s of [401, 403]) assert.equal(classifyN8nTokenCheck(s), 'invalid');
  for (const s of [null, 301, 404, 429, 500, 503]) assert.equal(classifyN8nTokenCheck(s, ok), 'unreachable');
});

test('checkN8nToken against a local MCP stand-in: valid / invalid / unreachable per scenario', async () => {
  const http = require('node:http');
  const { checkN8nToken } = loadTs('src/main/n8nTokenCheck.ts');
  const ok = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-03-26', serverInfo: { name: 'n8n' } } });
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(req.headers.authorization);
    req.resume();
    const send = (code, type, body, extra = {}) => { res.writeHead(code, { 'content-type': type, ...extra }); res.end(body); };
    switch (req.url) {
      case '/html': return send(200, 'text/html', '<html>login</html>');
      case '/rpc-error': return send(200, 'application/json', JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32603, message: 'boom' } }));
      case '/rpc-auth': return send(200, 'application/json', JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32001, message: 'Unauthorized' } }));
      case '/json': return send(200, 'application/json', ok);
      case '/sse': return send(200, 'text/event-stream', `event: message\ndata: ${ok}\n\n`);
      case '/sse-hang': res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(`data: ${ok}\n\n`); return; // never ends
      case '/sse-other-id': res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id: 999, result: { protocolVersion: 'x' } })}\n\n`); return;
      case '/sse-noise-then-reply': res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: {"jsonrpc":"2.0","method":"notifications/message"}\n\n'); setTimeout(() => res.write(`data: ${ok}\n\n`), 50); return;
      case '/empty-version': return send(200, 'application/json', JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '' } }));
      case '/json-other-id': return send(200, 'application/json', JSON.stringify({ jsonrpc: '2.0', id: 999, result: { protocolVersion: '2025-03-26' } }));
      case '/empty-result': return send(200, 'application/json', JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }));
      case '/sse-silent': res.writeHead(200, { 'content-type': 'text/event-stream' }); return; // no event, never ends
      case '/401': return send(401, 'text/plain', 'no');
      case '/500': return send(500, 'text/plain', 'x');
      case '/302': return send(302, 'text/plain', '', { location: '/json' });
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const run = (p, ms) => checkN8nToken(base + p, 'secret-token', '0.0.0', ms);
    assert.equal(await run('/json'), 'valid');
    assert.equal(await run('/sse'), 'valid');
    assert.equal(await run('/sse-hang'), 'valid'); // first event is enough
    assert.equal(await run('/html'), 'unreachable');
    assert.equal(await run('/rpc-error'), 'unreachable');
    assert.equal(await run('/rpc-auth'), 'invalid');
    assert.equal(await run('/401'), 'invalid');
    assert.equal(await run('/500'), 'unreachable');
    assert.equal(await run('/302'), 'unreachable');
    assert.equal(await run('/sse-noise-then-reply'), 'valid'); // held open, reply after a notification
    assert.equal(await run('/sse-other-id', 300), 'unreachable'); // unrelated id never counts
    assert.equal(await run('/empty-result'), 'unreachable');
    assert.equal(await run('/empty-version'), 'unreachable');
    assert.equal(await run('/json-other-id'), 'unreachable');
    assert.equal(await run('/sse-silent', 300), 'unreachable'); // time limit
    assert.ok(seen.every((a) => a === 'Bearer secret-token'));
  } finally { server.closeAllConnections(); server.close(); }
  assert.equal(await checkN8nToken(base + '/json', 't', '0.0.0'), 'unreachable'); // refused
});
