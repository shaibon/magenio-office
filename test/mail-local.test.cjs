'use strict';

// Mail area, local-model-only: loopback validation, fail-closed without a model, the
// strict summary schema, and what crosses to the hive. A fake local endpoint is the
// only "model" here; no mailbox and no real model is ever contacted.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const loadTs = require('./load-ts.cjs');

const M = loadTs('src/shared/mail.ts');
const { callLocalModel, probeLocalModel } = loadTs('src/main/mail/localModel.ts');
const { MAIL_SCHEMA_SQL, MAIL_SCHEMA_V3_SQL } = loadTs('src/main/mail/schema.ts');
const { MailStore } = loadTs('src/main/mail/store.ts');
const { runMailPoll } = loadTs('src/main/mail/poller.ts');

const ON = { enabled: true, baseUrl: 'http://127.0.0.1:11434', model: 'gpt-oss:20b' };
const REPLY = { category: 'bug', urgency: 'high', project_hint: 'VAI', confidence: 0.9, needs_reply: true, summary: 'Checkout broken\nWrite to ann@client.com\nCustomer cannot pay', suggested_action: 'Open a bug' };

/* ───────────────────────── loopback-only endpoint ───────────────────────── */

test('only a loopback origin is accepted; localhost is pinned to 127.0.0.1', () => {
  const n = M.normalizeLocalEndpoint;
  assert.equal(n('http://127.0.0.1:11434'), 'http://127.0.0.1:11434');
  assert.equal(n('http://localhost:11434/'), 'http://127.0.0.1:11434');
  assert.equal(n('HTTP://LocalHost'), 'http://127.0.0.1');
  assert.equal(n('http://[::1]:8080'), 'http://[::1]:8080');
  // The URL parser canonicalises numeric spellings; the result is genuinely loopback, so they are accepted as 127.0.0.1.
  assert.equal(n('http://2130706433'), 'http://127.0.0.1');
  assert.equal(n('http://127.1:11434'), 'http://127.0.0.1:11434');
  assert.equal(n('http://134744072'), null);                       // 8.8.8.8 in disguise
  for (const bad of [
    'https://api.openai.com', 'http://192.168.1.10:11434', 'http://10.0.0.5', 'http://0.0.0.0:11434', 'http://example.com',
    'http://127.0.0.1.evil.com', 'http://localhost.evil.com', 'http://evil.com@127.0.0.1', 'http://127.0.0.1@evil.com',
    'http://user:pw@127.0.0.1', 'ftp://127.0.0.1', 'file:///etc/passwd', 'http://127.0.0.1/v1', 'http://127.0.0.1?x=1',
    'http://[::ffff:8.8.8.8]', '', 'not a url', null, undefined, 42
  ]) assert.equal(n(bad), null, String(bad));
});

test('settings: remote hosts are refused, enabling needs a model, defaults are off', () => {
  assert.deepEqual(M.DEFAULT_MAIL_AGENT, { enabled: false, baseUrl: 'http://127.0.0.1:11434', model: '' });
  assert.equal(M.validateMailAgentSettings({ enabled: true, baseUrl: 'https://api.anthropic.com', model: 'x' }).ok, false);
  assert.equal(M.validateMailAgentSettings({ enabled: true, baseUrl: 'http://127.0.0.1:11434', model: '' }).ok, false);
  assert.equal(M.validateMailAgentSettings({ enabled: true, baseUrl: 'http://127.0.0.1:11434', model: 'a b' }).ok, false);
  const ok = M.validateMailAgentSettings({ enabled: true, baseUrl: 'http://localhost:1234', model: 'qwen3:30b-a3b' });
  assert.deepEqual(ok.value, { enabled: true, baseUrl: 'http://127.0.0.1:1234', model: 'qwen3:30b-a3b' });
  assert.equal(M.validateMailAgentSettings({ model: 'm' }).value.enabled, false);       // never on by accident
});

/* ───────────────────────────── the local call ───────────────────────────── */

function fakeFetch(reply) {
  const calls = [];
  const impl = async (url, init) => { calls.push({ url, init }); return typeof reply === 'function' ? reply(url, init) : reply; };
  return { impl, calls };
}
const okJson = (content) => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }], data: [{ id: 'gpt-oss:20b' }] }) });

test('callLocalModel posts to the loopback chat endpoint, refuses redirects, and returns the text', async () => {
  const f = fakeFetch(okJson('{"a":1}'));
  assert.equal(await callLocalModel(ON, 'PROMPT', { fetchImpl: f.impl }), '{"a":1}');
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, 'http://127.0.0.1:11434/v1/chat/completions');
  assert.equal(f.calls[0].init.redirect, 'error');
  const body = JSON.parse(f.calls[0].init.body);
  assert.equal(body.model, 'gpt-oss:20b');
  assert.equal(body.stream, false);
  assert.ok(body.messages.some((m) => m.content === 'PROMPT'));
  assert.ok(!('authorization' in f.calls[0].init.headers) && !Object.keys(f.calls[0].init.headers).some((k) => /auth|key/i.test(k)));
});

test('callLocalModel never calls out when misconfigured or tampered: no fetch at all', async () => {
  for (const s of [
    { ...ON, baseUrl: 'https://api.openai.com' }, { ...ON, baseUrl: 'http://192.168.0.9:11434' }, { ...ON, enabled: false },
    { ...ON, model: '' }, { enabled: true, baseUrl: '', model: 'm' }
  ]) {
    const f = fakeFetch(okJson('x'));
    await assert.rejects(callLocalModel(s, 'secret mail text', { fetchImpl: f.impl }), /not configured/);
    assert.equal(f.calls.length, 0, JSON.stringify(s));
  }
});

test('callLocalModel fails on HTTP errors, empty or malformed replies, and timeouts', async () => {
  await assert.rejects(callLocalModel(ON, 'p', { fetchImpl: fakeFetch({ ok: false, status: 500, json: async () => ({}) }).impl }), /HTTP 500/);
  await assert.rejects(callLocalModel(ON, 'p', { fetchImpl: fakeFetch(okJson('  ')).impl }), /no text/);
  await assert.rejects(callLocalModel(ON, 'p', { fetchImpl: fakeFetch({ ok: true, status: 200, json: async () => ({}) }).impl }), /no text/);
  await assert.rejects(callLocalModel(ON, 'p', { timeoutMs: 20, fetchImpl: (u, i) => new Promise((_, rej) => i.signal.addEventListener('abort', () => rej(new Error('aborted')))) }), /aborted/);
});

test('over real HTTP: only the loopback server is contacted; a redirect to elsewhere is refused', async () => {
  const hits = { a: [], b: 0 };
  const b = http.createServer((req, res) => { hits.b++; res.end('{}'); });
  await new Promise((r) => b.listen(0, '127.0.0.1', r));
  const a = http.createServer((req, res) => {
    let d = ''; req.on('data', (x) => { d += x; });
    req.on('end', () => {
      hits.a.push(req.url);
      if (req.url === '/v1/chat/completions' && /REDIRECT/.test(d)) { res.writeHead(307, { location: `http://127.0.0.1:${b.address().port}/steal` }); return res.end(); }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(req.url === '/v1/models' ? { data: [{ id: 'm1' }] } : { choices: [{ message: { content: '{"ok":true}' } }] }));
    });
  });
  await new Promise((r) => a.listen(0, '127.0.0.1', r));
  try {
    const s = { enabled: true, baseUrl: `http://localhost:${a.address().port}`, model: 'm1' };   // localhost -> 127.0.0.1
    assert.equal(await callLocalModel(s, 'hello'), '{"ok":true}');
    assert.deepEqual((await probeLocalModel(s)).ok, true);
    assert.equal((await probeLocalModel({ ...s, model: 'missing' })).ok, false);
    await assert.rejects(callLocalModel(s, 'REDIRECT me'));
    assert.equal(hits.b, 0, 'the redirect target was never contacted');
  } finally { a.close(); b.close(); }
});

test('probe reports an unreachable endpoint and refuses non-loopback URLs without fetching', async () => {
  const dead = fakeFetch(() => { throw new Error('ECONNREFUSED'); });
  const r = await probeLocalModel(ON, { fetchImpl: dead.impl });
  assert.equal(r.ok, false);
  assert.match(r.detail, /cannot reach the local model/);
  const f = fakeFetch(okJson('x'));
  assert.equal((await probeLocalModel({ ...ON, baseUrl: 'http://example.com' }, { fetchImpl: f.impl })).ok, false);
  assert.equal(f.calls.length, 0);
});

/* ──────────────────────── fail-closed pipeline + hand-off ──────────────────────── */

function pipeline({ classify, rules = [], keys = ['BURD', 'VAI'], messages }) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON'); db.exec(MAIL_SCHEMA_SQL); db.exec(MAIL_SCHEMA_V3_SQL);
  const store = new MailStore(db);
  store.upsertAccount({ id: 'acc', address: 'me@x.com', host: 'imap.x.com', port: 993, username: 'me', mailbox: 'INBOX', secretRef: 'mail:acc' });
  for (const r of rules) store.saveRule({ enabled: true, ...r });
  const handoffs = [];
  const deps = {
    store, getSecret: () => 'pw',
    makeProvider: () => ({ async fetchSince() { return { messages, uidValidity: 1 }; }, async close() {} }),
    classify, handoff: (h) => handoffs.push(h),
    knownProjectKeys: () => keys, pollIntervalMs: () => 60000, retentionDays: () => 30, log: () => {}, now: () => 1000
  };
  return { store, deps, handoffs };
}
const mail = (over = {}) => ({
  uid: 1, messageId: 'a@x', references: [], from: { name: 'Ann', address: 'ann@client.com' }, to: ['me@x.com'], subject: 'Secret subject', date: 1,
  text: 'SECRET BODY with ann@client.com and +39 333 1234567', automated: false, attachments: [], ...over
});

test('no local model: rules-only routing, NO summary, no hand-off, nothing else is tried', async () => {
  const p = pipeline({ classify: undefined, messages: [mail(), mail({ uid: 2, messageId: 'b@x', from: { name: '', address: 'z@other.org' } })], rules: [{ kind: 'fromDomain', pattern: 'client.com', projectKey: 'BURD' }] });
  await runMailPoll(p.deps);
  const [other, routed] = p.store.listMessages();
  assert.deepEqual([routed.triage.projectKey, routed.triage.via, routed.triage.summary, routed.triage.suggestedAction], ['BURD', 'rule', '', '']);
  assert.deepEqual([other.triage.projectKey, other.triage.summary], [null, '']);       // "Da assegnare"
  assert.deepEqual(p.handoffs, []);
});

test('an unreachable local model (classify returns null / throws) degrades to rules-only for that mail', async () => {
  for (const classify of [async () => null, async () => { throw new Error('ECONNREFUSED'); }]) {
    const p = pipeline({ classify, messages: [mail()], rules: [{ kind: 'fromDomain', pattern: 'client.com', projectKey: 'BURD' }] });
    await runMailPoll(p.deps);
    const t = p.store.listMessages()[0].triage;
    assert.deepEqual([t.projectKey, t.summary], ['BURD', '']);
    assert.deepEqual(p.handoffs, []);                                                   // no summary, so nothing crosses
  }
});

test('with a model: classification, summary and suggested action are stored, and the hand-off carries only the summary', async () => {
  const prompts = [];
  const p = pipeline({ classify: async (pr) => { prompts.push(pr); return JSON.stringify(REPLY); }, messages: [mail()] });
  await runMailPoll(p.deps);
  const t = p.store.listMessages()[0].triage;
  assert.deepEqual([t.projectKey, t.via, t.category, t.urgency, t.suggestedAction], ['VAI', 'model', 'bug', 'high', 'Open a bug']);
  assert.match(t.summary, /Checkout broken/);
  assert.match(prompts[0], /SECRET BODY/);                       // the local model does see the mail (that is the point)
  assert.equal(p.handoffs.length, 1);
  assert.deepEqual(Object.keys(p.handoffs[0]).sort(), ['classification', 'fromDomain', 'mailId', 'projectKey']);
  assert.equal(p.handoffs[0].fromDomain, 'client.com');
  const msg = M.handoffMessage(p.handoffs[0]);
  const all = `${msg.subject}\n${msg.body}`;
  for (const leak of ['SECRET BODY', 'Secret subject', 'ann@client.com', 'Ann', '1234567', '@']) assert.ok(!all.includes(leak), `leaked: ${leak}`);
  assert.match(msg.body, /sender domain: client\.com/);
  assert.match(msg.body, /\[address\]/);                          // the model's own echo of an address is masked
  assert.match(msg.body, /Checkout broken/);
  assert.match(msg.subject, /VAI #\d+: bug, high/);
});

test('an unrouted mail, or an automated one, is never handed off', async () => {
  const p = pipeline({
    classify: async () => JSON.stringify({ ...REPLY, project_hint: null }),
    messages: [mail(), mail({ uid: 2, messageId: 'n@x', automated: true })]
  });
  await runMailPoll(p.deps);
  assert.deepEqual(p.handoffs, []);
});

test('the summary schema is strict: 1-5 lines, a suggested action, valid enums', () => {
  assert.equal(M.parseClassification(JSON.stringify(REPLY)).suggestedAction, 'Open a bug');
  const bad = (o) => M.parseClassification(JSON.stringify({ ...REPLY, ...o }));
  assert.equal(bad({ summary: 'a\nb\nc\nd\ne\nf' }), null);         // 6 lines
  assert.equal(bad({ summary: '   \n  ' }), null);
  assert.equal(bad({ suggested_action: '' }), null);
  assert.equal(bad({ suggested_action: undefined }), null);
  assert.equal(bad({ suggested_action: 'x'.repeat(401) }), null);
  assert.equal(bad({ category: 'weird' }), null);
  assert.equal(M.parseClassification(JSON.stringify({ ...REPLY, summary: 'one line' })).summary, 'one line');
  assert.match(M.classifyPrompt('<<<UNTRUSTED_EMAIL_BEGIN>>>x', ['VAI']), /suggested_action/);
  assert.equal(M.redactAddresses('mail bob@x.co.uk, (eve@y.org)!'), 'mail [address], ([address])!');
});

/* ───────────────────────────── wiring ───────────────────────────── */

test('main wires the local agent only: PM-or-god hand-off, rules-only when disabled, IPC contract present', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/main/index.ts'), 'utf8');
  assert.match(src, /classify: mailAgentSettings\(\)\.enabled \? mailClassify : undefined/);
  assert.match(src, /callLocalModel\(s, prompt\)/);
  assert.match(src, /hive\.isPrivilegedPm\(id\)/);
  assert.match(src, /to: pm \?\? hive\.registry\(\)\.godId \?\? 'god'/);
  for (const ch of ['mail:agentGet', 'mail:agentSet', 'mail:agentTest']) assert.match(src, new RegExp(`ipcMain\\.handle\\('${ch}'`));
  const pre = fs.readFileSync(path.join(__dirname, '../src/preload/index.ts'), 'utf8');
  for (const fn of ['mailAgentGet', 'mailAgentSet', 'mailAgentTest']) assert.match(pre, new RegExp(fn));
});
