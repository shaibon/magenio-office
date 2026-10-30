'use strict';
// t-195: a session id is only a valid --resume key for the provider that made it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { HiveManager } = loadTs('src/main/hive.ts');
const { isResumeFailure, shouldRetryWithoutResume } = loadTs('src/shared/resumeFailure.ts');

const reg = (home) => JSON.parse(fs.readFileSync(path.join(home, 'hive', 'registry.json'), 'utf8')).agents;

test('switching provider drops the saved session; same provider keeps it', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-resume-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'a1', name: 'A', provider: 'codex', cwd: home });
  hive.recordSession('a1', '019aaaaa-0000-7000-8000-000000000001');
  assert.equal(reg(home).a1.sessionProvider, 'codex');
  assert.equal(hive.lastSession('a1', 'codex'), '019aaaaa-0000-7000-8000-000000000001');
  assert.equal(hive.lastSession('a1', 'deepcode'), undefined, 'other provider: not resumable');
  await hive.ensureAgent({ id: 'a1', name: 'A', provider: 'codex', cwd: home });
  assert.ok(reg(home).a1.sessionId, 'respawn on the same provider keeps the session');
  await hive.ensureAgent({ id: 'a1', name: 'A', provider: 'deepcode', cwd: home });
  assert.equal(reg(home).a1.sessionId, undefined, 'provider switch clears it');
  assert.equal(hive.lastSession('a1', 'deepcode'), undefined);
});

test('a legacy session (no sessionProvider) is also dropped when the provider changes', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-resume-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'a1', name: 'A', provider: 'claude', cwd: home });
  const p = path.join(home, 'hive', 'registry.json');
  const j = JSON.parse(fs.readFileSync(p, 'utf8')); j.agents.a1.sessionId = 'old-claude-id'; delete j.agents.a1.sessionProvider;
  fs.writeFileSync(p, JSON.stringify(j));
  await hive.ensureAgent({ id: 'a1', name: 'A', provider: 'deepcode', cwd: home });
  assert.equal(reg(home).a1.sessionId, undefined);
});

test('clearSession forgets a rejected session', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-resume-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'a1', name: 'A', provider: 'deepcode', cwd: home });
  hive.recordSession('a1', 'x');
  hive.clearSession('a1');
  assert.equal(hive.lastSession('a1'), undefined);
});

test('retry without --resume only for a quick non-zero exit that names an unknown session', () => {
  assert.equal(isResumeFailure('No saved session found with ID "abc".'), true);
  assert.equal(isResumeFailure('Invalid session ID: "019a…". Must be a valid UUID (e.g'), true);
  assert.equal(isResumeFailure('segfault'), false);
  const msg = 'No saved session found with ID "x"';
  assert.equal(shouldRetryWithoutResume(1, msg, 2000), true);
  assert.equal(shouldRetryWithoutResume(0, msg, 2000), false, 'clean exit');
  assert.equal(shouldRetryWithoutResume(1, msg, 60_000), false, 'late exit is a real death');
  assert.equal(shouldRetryWithoutResume(1, 'boom', 2000), false, 'other crash');
});

test('wiring: the exit handler relaunches before teardown, and spawn arms the retry only when it resumed', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/main/index.ts'), 'utf8');
  const a = src.indexOf('pendingResumeRetry.get(id)');
  assert.ok(a > 0 && a < src.indexOf('teardownPty(id, { keepRoster', a));
  assert.match(src, /res\.ok && didResume && !pristine\.noResumeRetry/);
  assert.match(src, /hive\.lastSession\(opts\.hive\.id, provider\)/);
});
