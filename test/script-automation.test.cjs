'use strict';
// t-343: `script` automations run a human-approved, hash-pinned program with no agent,
// and message the recipient only when it exits 10 or breaks.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { createScriptRunner, sha256Hex, approvalSignature, verifyApproval, readRegularFile } = loadTs('src/main/scriptAutomation.ts');
const A = loadTs('src/shared/agentAutomations.ts');

const KEY = 'test-approval-key';
const signed = (e) => ({ ...e, sig: approvalSignature(KEY, e) });

function setup(t, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'script-auto-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sent = []; const logs = []; const grants = []; const revoked = [];
  const approved = [];
  const runner = createScriptRunner({
    approved: () => approved,
    verify: (e) => verifyApproval(KEY, e),
    cacheDir: path.join(dir, 'cache'),
    grant: (id) => { grants.push(id); return { url: 'http://127.0.0.1:1', token: 'tok-ro' }; },
    revoke: (id) => revoked.push(id),
    send: (to, subject, body) => { sent.push({ to, subject, body }); return true; },
    log: (e) => logs.push(e),
    ...extra
  });
  /** Write a script, approve its CURRENT bytes, return the mission. */
  const make = (name, body, opts = {}) => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    approved.push(signed({ id: name, path: p, sha256: sha256Hex(fs.readFileSync(p)), approvedAt: 1 }));
    return { id: `m-${name}`, label: `check ${name}`, to: 'god', scriptId: name, ...opts, p };
  };
  return { dir, sent, logs, grants, revoked, runner, make, approved };
}

test('exit 0: nothing to report, no message', async (t) => {
  const s = setup(t);
  const m = s.make('ok.sh', 'echo fine; exit 0');
  const r = await s.runner.run(m);
  assert.equal(r.status, 'ok');
  assert.equal(s.sent.length, 0);
  assert.equal(s.logs.at(-1).outcome, 'ok');
  assert.equal(s.logs.at(-1).exitCode, 0);
});

test('exit 10: stdout is delivered to the recipient; long output is truncated', async (t) => {
  const s = setup(t);
  const m = s.make('found.sh', 'echo "disk almost full"; exit 10');
  const r = await s.runner.run(m);
  assert.equal(r.status, 'found');
  assert.deepEqual(s.sent, [{ to: 'god', subject: 'check found.sh', body: 'disk almost full' }]);
  assert.equal(s.logs.at(-1).outcome, 'found');
  const big = s.make('big.sh', 'i=0; while [ $i -lt 2000 ]; do echo "xxxxxxxxxxxxxxxxxxxx"; i=$((i+1)); done; exit 10');
  await s.runner.run(big);
  const body = s.sent.at(-1).body;
  assert.ok(body.length < 4100 && body.endsWith('…[truncated]'), `truncated, got ${body.length}`);
});

test('any other exit code is an ERROR message, never silence', async (t) => {
  const s = setup(t);
  const r = await s.runner.run(s.make('bad.sh', 'echo boom >&2; exit 3'));
  assert.equal(r.status, 'error');
  assert.equal(r.exitCode, 3);
  assert.equal(s.sent.length, 1);
  assert.match(s.sent[0].subject, /script check FAILED/);
  assert.match(s.sent[0].body, /exited with code 3/);
  assert.match(s.sent[0].body, /boom/);
  assert.equal(s.logs.at(-1).outcome, 'error');
  assert.equal(s.logs.at(-1).exitCode, 3);
});

test('a timeout kills the run and reports an error', async (t) => {
  const s = setup(t);
  const m = s.make('slow.sh', 'sleep 30; exit 0', { scriptTimeoutMs: 1000 });
  const t0 = Date.now();
  const r = await s.runner.run(m);
  assert.ok(Date.now() - t0 < 10_000, 'killed well before the sleep ended');
  assert.equal(r.status, 'error');
  assert.match(s.sent[0].body, /timed out/);
});

test('a script that cannot start (no shebang) is an error message', async (t) => {
  const s = setup(t);
  const p = path.join(s.dir, 'noshebang');
  fs.writeFileSync(p, 'echo hi\n', { mode: 0o755 });
  s.approved.push(signed({ id: 'ns', path: p, sha256: sha256Hex(fs.readFileSync(p)), approvedAt: 1 }));
  const r = await s.runner.run({ id: 'm-ns', label: 'ns', to: 'god', scriptId: 'ns' });
  assert.equal(r.status, 'error');
  assert.equal(s.sent.length, 1);
});

test('hash changed since approval: refused, NOT executed, error delivered', async (t) => {
  const s = setup(t);
  const marker = path.join(s.dir, 'ran');
  const m = s.make('tamper.sh', `touch ${marker}; exit 0`);
  fs.writeFileSync(m.p, `#!/bin/sh\ntouch ${marker}; echo evil; exit 0\n`); // an agent edits bin/
  const r = await s.runner.run(m);
  assert.equal(r.status, 'error');
  assert.match(r.reason, /hash mismatch/);
  assert.equal(fs.existsSync(marker), false, 'the changed script never ran');
  assert.equal(s.sent.length, 1);
  assert.equal(s.grants.length, 0, 'no broker token minted for a refused run');
});

test('unapproved or missing script: error message, nothing runs', async (t) => {
  const s = setup(t);
  assert.equal((await s.runner.run({ id: 'm1', label: 'x', to: 'god', scriptId: 'nope' })).status, 'error');
  const m = s.make('gone.sh', 'exit 0');
  fs.rmSync(m.p);
  assert.equal((await s.runner.run(m)).status, 'error');
  assert.equal(s.sent.length, 2);
});

test('what runs is a private copy of the verified bytes, with a minimal env and a read-only token', async (t) => {
  const s = setup(t);
  process.env.SECRET_FOR_TEST = 'leak-me';
  t.after(() => { delete process.env.SECRET_FOR_TEST; });
  const m = s.make('env.sh', 'echo "$0"; env; exit 10');
  await s.runner.run(m);
  const out = s.sent[0].body;
  assert.ok(!out.split('\n')[0].startsWith(s.dir + path.sep + 'env.sh'), 'not the agent-writable path');
  assert.ok(out.split('\n')[0].startsWith(path.join(s.dir, 'cache')), 'executed from the private cache dir');
  assert.match(out, /MD_BROKER_TOKEN=tok-ro/);
  assert.match(out, /MD_BROKER_URL=http:\/\/127\.0\.0\.1:1/);
  assert.ok(!/SECRET_FOR_TEST/.test(out), 'parent env is not inherited');
  assert.deepEqual(s.grants, ['m-env.sh']);
  assert.deepEqual(s.revoked, ['m-env.sh'], 'token revoked after the run');
  assert.deepEqual(fs.readdirSync(path.join(s.dir, 'cache')), [], 'copy removed');
  assert.equal(fs.statSync(path.join(s.dir, 'cache')).mode & 0o077, 0, 'cache dir is private');
});

test('the same script never overlaps itself', async (t) => {
  const s = setup(t);
  const m = s.make('long.sh', 'sleep 1; exit 10');
  const first = s.runner.run(m);
  const second = await s.runner.run(m);
  assert.equal(second.status, 'skipped');
  assert.equal((await first).status, 'found');
  assert.equal(s.sent.length, 1);
  assert.equal(s.runner.isRunning(m.id), false);
});

test('H1: a forged approval record (agent edited config.json) is refused and never runs', async (t) => {
  const s = setup(t);
  const marker = path.join(s.dir, 'forged-ran');
  const p = path.join(s.dir, 'forged.sh');
  fs.writeFileSync(p, `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
  const sha256 = sha256Hex(fs.readFileSync(p));
  const m = { id: 'm-f', label: 'f', to: 'god', scriptId: 'f' };
  for (const forged of [
    { id: 'f', path: p, sha256, approvedAt: 1 },                                        // no signature
    { id: 'f', path: p, sha256, approvedAt: 1, sig: 'a'.repeat(64) },                   // made-up signature
    { id: 'f', path: p, sha256, approvedAt: 1, sig: 'zz' },                             // malformed
    { ...signed({ id: 'f', path: '/bin/sh', sha256, approvedAt: 1 }), path: p },        // real signature, edited path
    { ...signed({ id: 'f', path: p, sha256: 'b'.repeat(64), approvedAt: 1 }), sha256 }  // real signature, edited hash
  ]) {
    s.approved.length = 0; s.approved.push(forged);
    const r = await s.runner.run(m);
    assert.equal(r.status, 'error');
    assert.match(r.reason, /not authentic/);
  }
  assert.equal(fs.existsSync(marker), false);
  assert.equal(s.sent.length, 5, 'every refusal is reported');
  // no usable key at all (Keychain unavailable): nothing verifies
  assert.equal(verifyApproval(null, signed({ id: 'f', path: p, sha256, approvedAt: 1 })), false);
  // a record signed with another key does not verify
  assert.equal(verifyApproval('other-key', signed({ id: 'f', path: p, sha256, approvedAt: 1 })), false);
});

test('H2: a FIFO (or symlink, or oversized file) in place of the script never blocks and is refused', async (t) => {
  const s = setup(t);
  const fifo = path.join(s.dir, 'fifo.sh');
  require('node:child_process').execFileSync('mkfifo', [fifo]);
  assert.throws(() => readRegularFile(fifo), /not a regular file/);
  s.approved.push(signed({ id: 'fifo', path: fifo, sha256: 'c'.repeat(64), approvedAt: 1 }));
  const t0 = Date.now();
  const r = await s.runner.run({ id: 'm-fifo', label: 'fifo', to: 'god', scriptId: 'fifo' });
  assert.ok(Date.now() - t0 < 2000, 'returned immediately, did not block on the pipe');
  assert.equal(r.status, 'error');
  assert.equal(s.sent.length, 1);
  // symlink as the last component is not followed
  const real = path.join(s.dir, 'real.sh'); fs.writeFileSync(real, '#!/bin/sh\nexit 0\n');
  const link = path.join(s.dir, 'link.sh'); fs.symlinkSync(real, link);
  assert.throws(() => readRegularFile(link));
  // bounded read
  const big = path.join(s.dir, 'big.bin'); fs.writeFileSync(big, Buffer.alloc(2048));
  assert.throws(() => readRegularFile(big, 1024), /too large/);
  assert.equal(readRegularFile(real).toString(), '#!/bin/sh\nexit 0\n');
});

test('M1: at the timeout the run ends and the broker token is revoked even if a grandchild keeps the pipes open', async (t) => {
  const { EventEmitter } = require('node:events');
  let destroyed = 0;
  // A child whose pipes stay open and which never emits "close", like a detached grandchild holding them.
  const fakeSpawn = () => {
    const c = new EventEmitter();
    const pipe = () => { const e = new EventEmitter(); e.destroy = () => { destroyed++; }; return e; };
    c.stdout = pipe(); c.stderr = pipe(); c.pid = undefined; c.kill = () => {};
    return c;
  };
  const s = setup(t, { spawn: fakeSpawn });
  const m = s.make('hang.sh', 'exit 0', { scriptTimeoutMs: 1000 });
  const t0 = Date.now();
  const r = await s.runner.run(m);
  assert.ok(Date.now() - t0 < 5000, 'did not wait for close');
  assert.equal(r.status, 'error');
  assert.match(s.sent[0].body, /timed out/);
  assert.deepEqual(s.revoked, ['m-hang.sh'], 'token revoked at the timeout');
  assert.equal(destroyed, 2, 'pipes dropped');
  assert.equal(s.runner.isRunning(m.id), false, 'a later tick is not blocked as overlap');
});

// ── no agent may create or change a script automation ─────────────────────────
function host(records) {
  return {
    list: () => records, save: (n) => { records.length = 0; records.push(...n); },
    targetExists: () => true, isGod: (id) => id === 'god-1', log: () => {}
  };
}

test('the broker /automations cannot create, change or delete a script automation (god included)', () => {
  const recs = [{ id: 'm_s', label: 's', intervalMs: 300000, to: 'god-1', body: '', enabled: true, kind: 'script', scriptId: 'x' }];
  const h = host(recs);
  for (const actor of ['agent-a', 'god-1']) {
    const body = { label: 'x', body: 'y', to: 'god-1', intervalMinutes: 10 };
    for (const extra of [{ kind: 'script' }, { scriptId: 'x' }, { script: '/bin/sh' }, { scriptTimeoutMs: 1 }]) {
      assert.equal(A.createAutomation(h, actor, { ...body, ...extra }).status, 400, JSON.stringify(extra));
    }
    assert.equal(A.updateAutomation(h, actor, 'm_s', { enabled: false }).status, 403);
    assert.equal(A.deleteAutomation(h, actor, 'm_s').status, 403);
  }
  // and an update cannot turn a dispatch trigger into a script one
  const r = A.createAutomation(h, 'god-1', { label: 'd', body: 'b', to: 'god-1', intervalMinutes: 10 });
  assert.equal(r.status, 201);
  assert.equal(A.updateAutomation(h, 'god-1', r.body.id, { kind: 'script' }).status, 400);
  assert.equal(recs.filter((m) => m.kind === 'script').length, 1);
});

test('wiring: fire() runs script missions through the runner; approval takes no path from the renderer', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/main/index.ts'), 'utf8');
  assert.match(src, /if \(m\.kind === 'script'\) \{[^}]*scriptRunner\.run\(m\)/s);
  assert.match(src, /verify: \(e\) => verifyApproval\(scriptApprovalKey\(false\), e\)/);
  assert.match(src, /sig: approvalSignature\(key, base\)/);
  assert.match(src, /ipcMain\.handle\('scripts:approve', async \(\) =>/);
  assert.match(src, /dialog\.showOpenDialog\(mainWindow/);
  assert.match(src, /integrationBroker\.grant\(`script:\$\{id\}`, integrations\.enabledIds\(\), \{ readOnly: true \}\)/);
});
