'use strict';

/**
 * Agent hibernation (t-279, phase 2a): the pure decider (table), the wake gate (race +
 * concurrency), and the hive state a sleeper leaves behind (registry / fleet / roster / log) —
 * the part a fake-PTY lifecycle can prove without Electron.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { holdReason, countDoingCards, WakeGate, Hibernator, HIBERNATE_BOOT_GRACE_MS } = loadTs('src/main/hibernation.ts');
const { WorkerWakeWatchdog } = loadTs('src/main/workerWake.ts');
const { HiveManager } = loadTs('src/main/hive.ts');

const NOW = 10_000_000;
const CFG = { minutes: 30, optIn: ['pam'] };
/** An agent that is hibernatable on every axis; each case flips ONE thing. */
const ok = (o = {}) => ({
  agentId: 'pam', isGod: false, isWorker: false, onHold: false, autoDeliveryPaused: false, paused: false, halted: false,
  ptyId: 'pty-pam', hasRecipe: true, hasSession: true,
  lastOutputAt: NOW - 31 * 60_000, spawnedAt: NOW - 3 * 3600_000, lastTurnWasStop: true,
  hitlRecently: false, inboxCount: 0, doingCards: 0, ...o
});

test('decider: an idle, opted-in, drained agent hibernates', () => {
  assert.equal(holdReason(ok(), CFG, NOW), null);
});

test('decider: every hard stop keeps the agent awake', () => {
  const cases = [
    [{ isGod: true }, 'god'], [{ isWorker: true }, 'worker'], [{ onHold: true }, 'on-hold'],
    [{ autoDeliveryPaused: true }, 'frozen'], [{ paused: true }, 'paused'], [{ halted: true }, 'halted'],
    [{ ptyId: undefined }, 'no-pty'], [{ hasRecipe: false }, 'no-recipe'], [{ hasSession: false }, 'no-session'],
    [{ spawnedAt: NOW - HIBERNATE_BOOT_GRACE_MS + 1000, lastOutputAt: 0 }, 'booting'],
    [{ lastOutputAt: NOW - 29 * 60_000 }, 'recent-output'],
    [{ lastTurnWasStop: false }, 'mid-turn'], [{ hitlRecently: true }, 'hitl'],
    [{ inboxCount: 1 }, 'inbox'], [{ doingCards: 1 }, 'doing-card']
  ];
  for (const [over, why] of cases) assert.equal(holdReason(ok(over), CFG, NOW), why, why);
});

test('decider: off and opt-in gates (phase 2a is opt-in, 0 = off)', () => {
  assert.equal(holdReason(ok(), { minutes: 0, optIn: ['pam'] }, NOW), 'off');
  assert.equal(holdReason(ok({ agentId: 'dwight' }), CFG, NOW), 'not-opted-in');
  assert.equal(holdReason(ok(), { minutes: 30, optIn: [] }, NOW), 'not-opted-in');
});

test('decider: a never-printed pty is judged from its spawn time, not as infinitely idle', () => {
  assert.equal(holdReason(ok({ lastOutputAt: 0, spawnedAt: NOW - 5 * 60_000 }), CFG, NOW), 'recent-output');
  assert.equal(holdReason(ok({ lastOutputAt: 0, spawnedAt: 0 }), CFG, NOW), 'recent-output');
});

test('doing cards block; blocked/review cards (waiting on a human) do not', () => {
  const ledger = { tasks: [
    { id: 't1', assignee: 'pam', status: 'blocked' }, { id: 't2', assignee: 'pam', status: 'review' },
    { id: 't3', assignee: 'pam', status: 'done' }, { id: 't4', assignee: 'oscar', status: 'doing' }
  ] };
  assert.equal(countDoingCards(ledger, 'pam'), 0);
  ledger.tasks.push({ id: 't5', assignee: 'pam', status: 'doing' });
  assert.equal(countDoingCards(ledger, 'pam'), 1);
  assert.equal(countDoingCards(null, 'pam'), 0);
  assert.equal(countDoingCards({ tasks: 'x' }, 'pam'), 0);
});

test('wake race: N concurrent events for one agent produce ONE spawn and share its result', async () => {
  const gate = new WakeGate(3);
  let spawns = 0;
  const task = async () => { spawns++; await new Promise((r) => setTimeout(r, 20)); return true; };
  const results = await Promise.all(['inbox', 'select', 'terminal-input', 'queued-message'].map(() => gate.run('pam', task)));
  assert.equal(spawns, 1);
  assert.deepEqual(results, [true, true, true, true]);
  assert.equal(gate.isWaking('pam'), false);
  await gate.run('pam', task); // a later, separate event spawns again
  assert.equal(spawns, 2);
});

test('wake concurrency: at most 3 spawns in flight across different agents', async () => {
  const gate = new WakeGate(3);
  let live = 0, peak = 0;
  const task = async () => { live++; peak = Math.max(peak, live); await new Promise((r) => setTimeout(r, 15)); live--; return true; };
  await Promise.all(Array.from({ length: 8 }, (_, i) => gate.run(`a${i}`, task)));
  assert.equal(peak, 3);
});

test('wake: a failing spawn is false, releases its slot, and does not poison the next wake', async () => {
  const gate = new WakeGate(1);
  assert.equal(await gate.run('pam', async () => { throw new Error('boom'); }), false);
  assert.equal(await gate.run('pam', async () => true), true);
});

test('watchdog accessors the reaper relies on', () => {
  const w = new WorkerWakeWatchdog();
  assert.equal(w.lastTurnWasStop('pam'), false);
  assert.equal(w.hitlRecently('pam', NOW), false);
  assert.equal(w.spawnedAtFor('pty-pam'), 0);
});

async function floor(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-hibernate-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'god-1', name: 'Michael', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'pam', name: 'Pam', provider: 'claude', cwd: home });
  return { home, hive };
}

test('hibernated: stays in the registry as NOT archived, with its session; wake clears it; both are logged', async (t) => {
  const { home, hive } = await floor(t);
  assert.ok(hive.setHibernated('pam', true, { sessionId: 'sess-1', reason: 'idle>30m' }).ok);
  let a = hive.registry().agents.pam;
  assert.equal(a.hibernated.sessionId, 'sess-1');
  assert.ok(!a.archived, 'hibernation must never archive');

  assert.ok(hive.setHibernated('pam', false, { reason: 'inbox', resumeLost: true }).ok);
  a = hive.registry().agents.pam;
  assert.equal(a.hibernated, undefined);

  const events = fs.readFileSync(path.join(hive.root(), 'log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const sleep = events.find((e) => e.kind === 'agent-hibernate');
  const wake = events.find((e) => e.kind === 'agent-wake');
  assert.equal(sleep.id, 'pam');
  assert.equal(sleep.reason, 'idle>30m');
  assert.equal(wake.resumeLost, true);
  assert.equal(hive.setHibernated('nobody', true).ok, false);
});

test('hibernated: fleet.json row is patched and the roster says AVAILABLE, not dead', async (t) => {
  const { hive } = await floor(t);
  hive.writeFleetSnapshot({
    ts: Date.now(),
    agents: [
      { id: 'god-1', name: 'Michael', role: 'orchestrator', isGod: true, breaker: 'ok', tokens: 1, usd: 0, lastActiveSecAgo: 1, inboxBacklog: 0 },
      { id: 'pam', name: 'Pam', role: 'agent', breaker: 'ok', tokens: 0, usd: 0, lastActiveSecAgo: 3600, inboxBacklog: 0, hibernated: false }
    ]
  });
  hive.setHibernated('pam', true, { sessionId: 's' });
  const fleet = JSON.parse(fs.readFileSync(path.join(hive.root(), 'fleet.json'), 'utf8'));
  assert.equal(fleet.agents.find((x) => x.id === 'pam').hibernated, true);

  // the periodic refresh writes a fleet row WITH the flag, as index.ts does from the registry
  hive.writeFleetSnapshot({ ts: Date.now(), agents: fleet.agents });
  const line = hive.rosterContext();
  assert.match(line, /pam[^;]*HIBERNATED — wakes on mail/);
  assert.match(line, /AVAILABLE/);
  assert.match(line, /do NOT treat it as dead/);
});

/** A fake app: ptys are strings, spawn is a counter, and every effect is recorded. */
function fakeApp({ session = 'sess-1', spawnOk = true, mail = 0, killFails = false } = {}) {
  const st = { hibernated: false, live: new Set(['pty-pam']), killed: [], torn: [], notes: [], spawns: [], flagWrites: [], mail, session, archived: false, worktreeRemoved: false };
  const recipe = { opts: { id: 'pty-pam', cwd: '/wt/pam', isolate: false, resume: true } };
  const h = new Hibernator({
    ptyFor: (id) => (id === 'pam' && st.live.has('pty-pam') ? 'pty-pam' : undefined),
    recipeFor: () => recipe,
    sessionFor: () => st.session || undefined,
    isHibernated: () => st.hibernated,
    setHibernated: (id, on, info) => { st.flagWrites.push([on, info?.reason]); st.hibernated = on; return true; },
    killPty: (p) => { st.killed.push(p); if (killFails) return false; st.live.delete(p); return true; },
    teardownLight: (p) => { st.torn.push(p); /* the light teardown must not archive or remove the worktree */ },
    respawn: async (id, r, reason) => { st.spawns.push([r.opts.resume, reason]); await new Promise((x) => setTimeout(x, 5)); if (spawnOk) { st.live.add('pty-pam'); st.hibernated = false; /* spawnAgentCore clears the flag */ } return spawnOk; },
    notify: (id, pty, hib) => st.notes.push(hib),
    inboxCount: () => st.mail
  });
  return { h, st };
}

test('lifecycle (fake pty): hibernate keeps the agent, wake resumes it exactly once', async () => {
  const { h, st } = fakeApp();
  assert.equal(h.hibernate('pam', 'idle>30m'), true);
  assert.deepEqual(st.killed, ['pty-pam']);
  assert.deepEqual(st.torn, ['pty-pam']);
  assert.equal(st.hibernated, true);
  assert.equal(h.sleeperOf('pty-pam'), 'pam', 'input to the dead pty must be attributable to the sleeper');
  assert.equal(h.hibernate('pam', 'again'), false, 'already asleep: nothing to do');

  const r = await Promise.all([h.wake('pam', 'inbox'), h.wake('pam', 'select'), h.wake('pam', 'terminal-input')]);
  assert.deepEqual(r, [true, true, true]);
  assert.equal(st.spawns.length, 1, 'three racing events, one spawn');
  assert.equal(st.spawns[0][0], true, 'the wake resumes the session');
  assert.equal(st.hibernated, false);
  assert.equal(h.sleeperOf('pty-pam'), undefined);
  assert.deepEqual(st.notes, [true, false]);
  assert.equal(await h.wake('pam', 'late'), false, 'awake agent: a stray event is a no-op');
});

test('lifecycle: no recorded session => never hibernates (a blank wake would lose the context)', () => {
  const { h, st } = fakeApp({ session: null });
  assert.equal(h.hibernate('pam', 'x'), false);
  assert.deepEqual(st.killed, []);
  assert.equal(st.hibernated, false);
});

test('lifecycle: failed registry write => the process is NOT killed', () => {
  const { h, st } = fakeApp();
  const h2 = new Hibernator({ ...h.d, setHibernated: () => false });
  assert.equal(h2.hibernate('pam', 'x'), false);
  assert.deepEqual(st.killed, []);
});

test('race: mail landing during hibernation wakes the agent immediately', async () => {
  const { h, st } = fakeApp({ mail: 2 });
  h.hibernate('pam', 'idle');
  await new Promise((x) => setTimeout(x, 30));
  assert.equal(st.spawns.length, 1);
  assert.equal(st.hibernated, false);
});

test('a failed wake leaves the agent hibernated (still available, retried by the next event)', async () => {
  const { h, st } = fakeApp({ spawnOk: false });
  h.hibernate('pam', 'idle');
  assert.equal(await h.wake('pam', 'inbox'), false);
  assert.equal(st.hibernated, true);
  assert.equal(h.sleeperOf('pty-pam'), 'pam');
});

test('a failed PTY kill rolls everything back: still awake, no light teardown, no sleeper, flag cleared', async () => {
  const { h, st } = fakeApp({ killFails: true });
  assert.equal(h.hibernate('pam', 'idle'), false);
  assert.deepEqual(st.killed, ['pty-pam']);
  assert.deepEqual(st.torn, [], 'light teardown (broker revoke, ptyToAgent) must not run for a live process');
  assert.equal(st.hibernated, false);
  assert.equal(h.sleeperOf('pty-pam'), undefined, 'input to the live pty must not be swallowed');
  assert.deepEqual(st.flagWrites.map((w) => w[0]), [true, false]);
  assert.equal(await h.wake('pam', 'inbox'), false, 'nothing to wake');
  assert.equal(st.spawns.length, 0, 'no duplicate-PTY spawn');
});

test('forged registry flag on a LIVE agent: no respawn, no grant rotation, flag cleared', async () => {
  const { h, st } = fakeApp();
  st.hibernated = true; // a peer wrote registry.json; the agent still has its pty and there is no sleeper record
  assert.equal(await h.wake('pam', 'inbox'), false);
  assert.equal(st.spawns.length, 0, 'respawn is what rotates the n8n token / fails on a duplicate pty');
  assert.equal(st.hibernated, false, 'inconsistent flag is cleared');
  assert.ok(st.live.has('pty-pam'));
});

test('stale flag with a sleeper record but a live pty is also refused', async () => {
  const { h, st } = fakeApp();
  h.hibernate('pam', 'idle');
  st.live.add('pty-pam'); // somehow alive again (e.g. renderer respawn) while the record lingers
  assert.equal(await h.wake('pam', 'inbox'), false);
  assert.equal(st.spawns.length, 0);
});

test('forget() drops the sleeper so a later wake cannot respawn it', async () => {
  const { h, st } = fakeApp();
  h.hibernate('pam', 'idle');
  h.forget('pam');
  assert.equal(h.isSleeper('pam'), false);
  assert.equal(await h.wake('pam', 'inbox'), false);
  assert.equal(st.spawns.length, 0);
});

test('peer deletes a real sleeper\'s registry flag: the sleeper record still wakes it and repairs the flag', async () => {
  const { h, st } = fakeApp();
  h.hibernate('pam', 'idle');
  st.hibernated = false; // registry.json is agent-writable
  assert.equal(h.hibernate('pam', 'again'), false, 'not re-hibernated either');
  assert.equal(await h.wake('pam', 'inbox'), true);
  assert.equal(st.spawns.length, 1);
  assert.deepEqual(st.flagWrites.map((w) => w[1]).includes('flag-repaired'), true);
  assert.equal(h.isSleeper('pam'), false);
});

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src/main/index.ts'), 'utf8');

test('wiring (index.ts): the light teardown neither archives nor removes the worktree', () => {
  const body = SRC.slice(SRC.indexOf('function teardownPty('), SRC.indexOf('/** Send an inform to the god agent'));
  assert.match(body, /hive\.enabled\(\) && !opts\.hibernate/, 'setArchived must be skipped when hibernating');
  assert.match(body, /opts\.hibernate \|\| opts\.keepWorktree \? undefined : worktreePaths\.get\(id\)/, 'worktree removal must be skipped');
});

test('wiring (index.ts): terminal input to a sleeper wakes it; mail wakes it; spawn clears the flag', () => {
  assert.match(SRC, /hibernator\.sleeperOf\(id\)[\s\S]{0,120}wakeAgent\(sleeper, 'terminal-input'\)/);
  assert.match(SRC, /a\?\.hibernated \|\| hibernator\.isSleeper\(agentId\)\) \{ if \(hive\.inbox\(agentId\)\.length > 0\) void wakeAgent\(agentId, 'inbox'\)/);
  assert.match(SRC, /hive\.setHibernated\(opts\.hive\.id, false/);
  assert.match(SRC, /hibernated: !!a\.hibernated/, 'fleet.json must carry the flag');
});

test('wiring (index.ts): closing a sleeper never runs the worktree-removing teardown', () => {
  const i = SRC.indexOf('function closeSleeper(');
  const body = SRC.slice(i, SRC.indexOf('const hibernateAgent', i));
  assert.doesNotMatch(body, /teardownPty|removeWorktree/, 'closeSleeper must not tear down');
  assert.match(body, /hibernator\.forget/);
  const kill = SRC.slice(SRC.indexOf("ipcMain.handle('pty:kill'"), SRC.indexOf("ipcMain.handle('pty:list'"));
  assert.ok(kill.indexOf('closeSleeper(id)') !== -1 && kill.indexOf('closeSleeper(id)') < kill.indexOf('teardownPty(id)'), 'pty:kill checks the sleeper first');
  const voice = SRC.slice(SRC.indexOf('killAgent: (id) =>'), SRC.indexOf('spawnAgent: async'));
  assert.match(voice, /closeSleeper\(id\)/);
  assert.match(SRC, /agent:isHibernated[\s\S]{0,160}hibernator\.isSleeper/, 'UI state follows the in-process record, not the registry flag');
});
