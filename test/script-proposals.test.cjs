'use strict';
// t-343 phase 3: one-click approval. god proposes a check script; only the Boss's click approves it, in main, from stored data.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const loadTs = require('./load-ts.cjs');

const S = loadTs('src/main/scriptAutomation.ts');
const P = loadTs('src/main/scriptProposals.ts');
const { IntegrationBroker } = loadTs('src/main/integrationBroker.ts');
const KEY = 'proposal-test-key';

function setup(t, missions = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'script-prop-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const logs = [];
  const state = { missions: [...missions] };
  const host = {
    dir: path.join(dir, 'proposals'),
    isGod: (id) => id === 'god-1',
    isBuiltIn: (id) => id === 'ops-standup',
    key: () => KEY,
    missions: () => state.missions,
    log: (e) => logs.push(e)
  };
  const script = (name, body = 'exit 0') => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, `#!/bin/sh\n${body}\n`);
    return fs.realpathSync(p);
  };
  const base = (p, extra = {}) => ({ path: p, label: 'Disk check', description: 'Reports a full disk', intervalMinutes: 30, ...extra });
  return { dir, host, logs, state, script, base };
}
const cfg = (o = {}) => ({ approvedScripts: [], missions: [], ...o });

test('only god can propose; an agent gets 403 and nothing is stored', (t) => {
  const s = setup(t);
  const p = s.script('a.sh');
  assert.equal(P.propose(s.host, 'agent-evil', s.base(p)).status, 403);
  assert.equal(P.listProposals(s.host).length, 0);
  assert.equal(P.propose(s.host, 'god-1', s.base(p)).status, 201);
  assert.equal(P.listProposals(s.host).length, 1);
});

test('proposal validation: path, shebang, schedule, timeout, unknown fields, text', (t) => {
  const s = setup(t);
  const p = s.script('a.sh');
  const bad = (patch) => P.propose(s.host, 'god-1', { ...s.base(p), ...patch }).status;
  assert.equal(bad({ path: 'relative.sh' }), 400);
  assert.equal(bad({ path: '/nonexistent/x.sh' }), 400);
  assert.equal(bad({ path: s.dir }), 400, 'a directory is not a script');
  assert.equal(bad({ label: '' }), 400);
  assert.equal(bad({ label: 'x\ny' }), 400, 'control characters');
  assert.equal(bad({ description: 'a'.repeat(501) }), 400);
  assert.equal(bad({ intervalMinutes: 1 }), 400);
  assert.equal(bad({ intervalMinutes: undefined }), 400, 'a schedule is required');
  assert.equal(bad({ weekly: { days: [1], minute: 540 } }), 400, 'not both');
  assert.equal(bad({ timeoutSec: 601 }), 400);
  assert.equal(bad({ approved: true }), 400, 'unknown field');
  assert.equal(bad({ sha256: 'x' }), 400, 'a caller-supplied hash is never accepted');
  const noShebang = path.join(s.dir, 'plain.txt'); fs.writeFileSync(noShebang, 'echo hi\n');
  assert.equal(bad({ path: noShebang }), 400);
  assert.equal(P.propose(s.host, 'god-1', { path: p, label: 'W', description: 'd', weekly: { days: [1, 2], minute: 540 }, timeoutSec: 120 }).status, 201);
});

test('a FIFO or a symlink in place of the script is refused at proposal time without blocking', (t) => {
  const s = setup(t);
  const fifo = path.join(s.dir, 'fifo.sh');
  require('node:child_process').execFileSync('mkfifo', [fifo]);
  const t0 = Date.now();
  assert.equal(P.propose(s.host, 'god-1', s.base(fifo)).status, 400);
  assert.ok(Date.now() - t0 < 2000);
});

test('replaces: only a dispatch trigger that is not another agent\'s; built-in, heartbeat, script, unknown and agent-only are refused', (t) => {
  const s = setup(t, [
    { id: 'op', label: 'Operator trigger', kind: 'dispatch', enabled: true, to: 'god-1', body: 'b', intervalMs: 1 },
    { id: 'by-god', label: 'God trigger', enabled: true, to: 'god-1', body: 'b', intervalMs: 1, createdBy: 'god-1' },
    { id: 'by-pty-god', label: 'Legacy god trigger', enabled: true, to: 'god-1', body: 'b', intervalMs: 1, createdBy: 'pty-god-1' },
    { id: 'by-pty-agent', label: 'Legacy agent trigger', enabled: true, to: 'agent-x', body: 'b', intervalMs: 1, createdBy: 'pty-agent-x' },
    { id: 'by-agent', label: 'Agent-only trigger', enabled: true, to: 'agent-x', body: 'b', intervalMs: 1, createdBy: 'agent-x' },
    { id: 'hb', label: 'Heartbeat', kind: 'heartbeat', enabled: true, to: 'god-1', body: '', intervalMs: 1 },
    { id: 'sc', label: 'A script', kind: 'script', enabled: true, to: '', body: '', intervalMs: 1 },
    { id: 'ops-standup', label: 'Ops standup', enabled: true, to: 'god-1', body: 'b', intervalMs: 1 }
  ]);
  const p = s.script('a.sh');
  const code = (replaces) => P.propose(s.host, 'god-1', { ...s.base(p, { label: `L${replaces}` }), replaces }).status;
  assert.equal(code('op'), 201);
  assert.equal(code('by-god'), 201);
  assert.equal(code('by-pty-god'), 201, 'legacy pty-<godId> creator');
  assert.equal(code('by-pty-agent'), 403, 'legacy pty-<other agent>');
  assert.equal(code('by-agent'), 403, 'agent-only trigger');
  assert.equal(code('hb'), 403, 'not a dispatch trigger');
  assert.equal(code('sc'), 403);
  assert.equal(code('nope'), 403);
  assert.equal(code('ops-standup'), 403, 'built-in has no kind or createdBy but is still refused');
});

test('approval is atomic: script + mission signed, the replaced trigger switched off, the proposal consumed', (t) => {
  const s = setup(t, [{ id: 'old', label: 'Old poll', kind: 'dispatch', enabled: true, to: 'god-1', body: 'wake', intervalMs: 1800000 }]);
  const p = s.script('a.sh', 'echo found; exit 10');
  const id = P.propose(s.host, 'god-1', s.base(p, { replaces: 'old', timeoutSec: 90 })).body.id;
  const r = P.approveProposal(s.host, id, cfg({ missions: s.state.missions }));
  assert.equal(r.ok, true, r.error);
  const m = r.missions.find((x) => x.kind === 'script');
  assert.equal(m.label, 'Disk check'); assert.equal(m.to, ''); assert.equal(m.enabled, true);
  assert.equal(m.intervalMs, 1800000); assert.equal(m.scriptTimeoutMs, 90000);
  assert.equal(S.verifyMissionSig(KEY, m), true, 'mission signed');
  const entry = r.approvedScripts.find((a) => a.id === m.scriptId);
  assert.equal(S.verifyApproval(KEY, entry), true, 'script approval signed');
  assert.equal(entry.sha256, S.sha256Hex(fs.readFileSync(p)));
  assert.equal(r.missions.find((x) => x.id === 'old').enabled, false, 'replaced trigger switched off');
  assert.equal(r.replaced, 'Old poll');
  // nothing is written by approveProposal itself: the caller does ONE write, then finishes
  assert.equal(P.listProposals(s.host).length, 1);
  P.finishApproval(s.host, id, {});
  assert.equal(P.listProposals(s.host).length, 0);
  assert.equal(fs.existsSync(path.join(s.host.dir, `${id}.copy`)), false);
});

test('approval fails as a whole: nothing applied when the file changed after the proposal', (t) => {
  const s = setup(t, [{ id: 'old', label: 'Old poll', kind: 'dispatch', enabled: true, to: 'god-1', body: 'wake', intervalMs: 1 }]);
  const p = s.script('a.sh');
  const id = P.propose(s.host, 'god-1', s.base(p, { replaces: 'old' })).body.id;
  fs.writeFileSync(p, '#!/bin/sh\necho evil\n'); // an agent edits the file after the proposal
  const before = JSON.stringify(s.state.missions);
  const r = P.approveProposal(s.host, id, cfg({ missions: s.state.missions }));
  assert.equal(r.ok, false);
  assert.match(r.error, /changed after it was proposed/);
  assert.equal(JSON.stringify(s.state.missions), before, 'the replaced trigger was not touched');
  assert.equal(P.listProposals(s.host).length, 1, 'the proposal stays, untouched');
});

test('approval fails when the stored copy or record is tampered with at rest, or the trigger became un-replaceable', (t) => {
  const s = setup(t, [{ id: 'old', label: 'Old poll', kind: 'dispatch', enabled: true, to: 'god-1', body: 'wake', intervalMs: 1 }]);
  const p = s.script('a.sh');
  const id = P.propose(s.host, 'god-1', s.base(p, { replaces: 'old' })).body.id;
  const copy = path.join(s.host.dir, `${id}.copy`);
  fs.writeFileSync(copy, '#!/bin/sh\necho swapped\n');
  assert.match(P.approveProposal(s.host, id, cfg({ missions: s.state.missions })).error, /copy changed/);
  assert.equal(P.listProposals(s.host)[0].intact, false);
  fs.writeFileSync(copy, fs.readFileSync(p)); // restore
  // the record itself edited (a different path): signature breaks
  const file = path.join(s.host.dir, 'proposals.json');
  const list = JSON.parse(fs.readFileSync(file, 'utf8')); list[0].path = '/bin/sh'; fs.writeFileSync(file, JSON.stringify(list));
  assert.match(P.approveProposal(s.host, id, cfg({ missions: s.state.missions })).error, /not authentic/);
  assert.equal(P.listProposals(s.host).length, 0, 'a record that does not verify is not shown');
  // the trigger turned into an agent-only one between proposal and click
  const id2 = P.propose(s.host, 'god-1', s.base(p, { label: 'Other', replaces: 'old' })).body.id;
  s.state.missions[0] = { ...s.state.missions[0], createdBy: 'agent-x' };
  const r = P.approveProposal(s.host, id2, cfg({ missions: s.state.missions }));
  assert.equal(r.ok, false); assert.match(r.error, /cannot switch off/);
});

test('approval acts on STORED data: an unknown id, or one the renderer invents, does nothing', (t) => {
  const s = setup(t);
  assert.equal(P.approveProposal(s.host, 'p_invented', cfg()).ok, false);
  assert.equal(P.rejectProposal(s.host, 'p_invented'), false);
});

test('a changed script updates the SAME mission: new hash, new signature, no second row, enabled state kept', (t) => {
  const s = setup(t);
  const p = s.script('a.sh', 'exit 0');
  let id = P.propose(s.host, 'god-1', s.base(p)).body.id;
  let r = P.approveProposal(s.host, id, cfg());
  assert.equal(r.ok, true, r.error); P.finishApproval(s.host, id, {});
  const first = r.missions.find((m) => m.kind === 'script');
  // the Boss switched it off; god ships a new version of the script
  const off = S.signedScriptMission(KEY, { id: first.id, label: first.label, scriptId: first.scriptId, intervalMs: first.intervalMs, enabled: false, lastFiredAt: 1 });
  s.state.missions = [off];
  fs.writeFileSync(p, '#!/bin/sh\nexit 10\n');
  const prop = P.propose(s.host, 'god-1', s.base(p, { intervalMinutes: 15 }));
  assert.equal(prop.body.updates, first.id);
  assert.equal(P.listProposals(s.host)[0].updatesLabel, 'Disk check');
  r = P.approveProposal(s.host, prop.body.id, cfg({ approvedScripts: [r.approvedScripts[0]], missions: s.state.missions }));
  assert.equal(r.ok, true, r.error);
  assert.equal(r.missions.length, 1, 'no second row');
  assert.equal(r.approvedScripts.length, 1, 'no second approval');
  assert.equal(r.missions[0].id, first.id);
  assert.equal(r.missions[0].enabled, false, 'still off');
  assert.equal(r.missions[0].intervalMs, 15 * 60000);
  assert.equal(r.approvedScripts[0].sha256, S.sha256Hex(fs.readFileSync(p)));
  assert.equal(S.verifyMissionSig(KEY, r.missions[0]), true);
  assert.equal(S.verifyApproval(KEY, r.approvedScripts[0]), true);
});

test('a second proposal with the same label replaces the pending one (and its copy)', (t) => {
  const s = setup(t);
  const p = s.script('a.sh');
  const a = P.propose(s.host, 'god-1', s.base(p)).body.id;
  fs.writeFileSync(p, '#!/bin/sh\nexit 3\n');
  const b = P.propose(s.host, 'god-1', s.base(p, { label: 'disk CHECK' })).body.id;
  const list = P.listProposals(s.host);
  assert.deepEqual(list.map((x) => x.id), [b]);
  assert.equal(fs.existsSync(path.join(s.host.dir, `${a}.copy`)), false);
});

test('reject removes the proposal and its copy; the shown content is the stored copy', (t) => {
  const s = setup(t);
  const p = s.script('a.sh', 'echo hello');
  const id = P.propose(s.host, 'god-1', s.base(p)).body.id;
  const v = P.listProposals(s.host)[0];
  assert.match(v.content, /echo hello/); assert.equal(v.intact, true); assert.equal(v.proposedBy, 'god-1');
  assert.equal(P.rejectProposal(s.host, id), true);
  assert.equal(P.listProposals(s.host).length, 0);
  assert.equal(fs.existsSync(path.join(s.host.dir, `${id}.copy`)), false);
});

test('the broker: /script-proposals needs a writable capability and the host decides who is god', async (t) => {
  const s = setup(t);
  const p = s.script('a.sh');
  const broker = new IntegrationBroker({
    getRecord: () => undefined, getSecret: () => undefined,
    scriptProposals: {
      propose: (actor, raw) => P.propose(s.host, actor, raw),
      pending: (actor) => (s.host.isGod(actor) ? { status: 200, body: { pending: P.listProposals(s.host).map((x) => x.label) } } : { status: 403, body: {} })
    }
  });
  await broker.start();
  t.after(() => broker.stop?.());
  const god = broker.grant('pty-god', [], { agentId: 'god-1' });
  const worker = broker.grant('pty-w', [], { agentId: 'agent-evil' });
  const pm = broker.grant('pty-pm', [], { agentId: 'pam-1', readOnly: true, pmJira: true });
  const call = (tok, method, body) => fetch(`${broker.url()}/script-proposals`, { method, headers: { 'x-md-broker-token': tok, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  assert.equal((await call(worker, 'POST', s.base(p))).status, 403, 'a non-god agent');
  assert.equal((await call(pm, 'POST', s.base(p))).status, 403, 'a read-only token cannot write');
  assert.equal((await call('bogus', 'POST', s.base(p))).status, 401);
  assert.equal((await call(god, 'POST', s.base(p))).status, 201);
  assert.equal((await call(god, 'POST', { ...s.base(p), approve: true })).status, 400, 'no approve/sign/mission fields exist');
  assert.equal((await call(god, 'DELETE')).status, 405);
  const list = await (await call(god, 'GET')).json();
  assert.deepEqual(list.pending, ['Disk check']);
  assert.equal((await call(worker, 'GET')).status, 403);
  assert.equal(P.listProposals(s.host).length, 1);
});

test('wiring: approval and reject are renderer-only IPCs acting on stored data; there is no file picker any more', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/main/index.ts'), 'utf8');
  assert.match(src, /const fromUi = \(evt: Electron\.IpcMainInvokeEvent\): boolean => !!mainWindow && evt\.sender === mainWindow\.webContents;/);
  assert.match(src, /ipcMain\.handle\('scripts:approveProposal', \(evt, id: unknown\) => \{\s*if \(!fromUi\(evt\)/);
  assert.match(src, /writeConfig\(\{ approvedScripts: r\.approvedScripts, missions: r\.missions as ScheduledMission\[\] \}\)/, 'one config write');
  assert.match(src, /ipcMain\.handle\('scripts:rejectProposal', \(evt, id: unknown\) => \(fromUi\(evt\)/);
  assert.match(src, /scriptProposals: \{\s*propose: \(actor, raw\) => proposeScript\(proposalHost, actor, raw\)/);
  assert.doesNotMatch(src, /showOpenDialog\(mainWindow[^)]*Approve a script/);
  const ui = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/src/components/triggers/SchedulesSection.tsx'), 'utf8');
  assert.doesNotMatch(ui, /approveScript\(\)|saveScriptMission|dangerouslySetInnerHTML|innerHTML/);
  assert.match(ui, /<pre style=/);
});
