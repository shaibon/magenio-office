'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { buildTempHistory, filterTempHistory, totalTempHistory, firstLine } = loadTs('src/shared/tempHistory.ts');
const { CostLedgerTotals } = loadTs('src/main/costLifetime.ts');

const NOW = 1_000_000_000;
const H = 3600_000;
const base = (over = {}) => ({
  now: NOW, requests: [], log: [], registry: {}, doneAt: {}, usage: {},
  worktreeKept: [], live: [], tasks: [], ...over
});
const spawn = (id, ts) => ({ ts, kind: 'spawn', agentId: id });
const archive = (id, ts) => ({ ts, kind: 'archive', agentId: id, archived: true });
const byId = (rows, id) => rows.find((r) => r.workerId === id);

test('statuses: running, done, killed, failed, preserved', () => {
  const rows = buildTempHistory(base({
    requests: [
      { workerId: 'worker-bad', state: 'failed', at: NOW - H },
      { workerId: 'worker-run', state: 'done', at: NOW - H, objective: '\n  Fix it\nmore' }
    ],
    log: [
      spawn('worker-run', NOW - H),
      spawn('worker-done', NOW - 5 * H), archive('worker-done', NOW - 4 * H),
      spawn('worker-kill', NOW - 5 * H), archive('worker-kill', NOW - 4 * H),
      spawn('worker-crash', NOW - 5 * H), archive('worker-crash', NOW - 4 * H),
      { ts: NOW - 4 * H, kind: 'agent-exit', agentId: 'worker-crash', abnormal: true },
      spawn('worker-kept', NOW - 5 * H), archive('worker-kept', NOW - 4 * H)
    ],
    doneAt: { 'worker-done': NOW - 4 * H, 'worker-kept': NOW - 4 * H },
    worktreeKept: ['worker-kept']
  }));
  const st = (id) => byId(rows, id).status;
  assert.equal(st('worker-bad'), 'failed');
  assert.equal(st('worker-run'), 'running');
  assert.equal(st('worker-done'), 'done');
  assert.equal(st('worker-kill'), 'killed');
  assert.equal(st('worker-crash'), 'failed');
  assert.equal(st('worker-kept'), 'preserved-worktree');
  assert.equal(byId(rows, 'worker-run').objective, 'Fix it');
  assert.equal(byId(rows, 'worker-done').durationMs, H);
  assert.equal(byId(rows, 'worker-run').durationMs, H); // open: measured to now
});

test('a respawn after the last archive is running again; start is the first spawn', () => {
  const rows = buildTempHistory(base({
    log: [spawn('worker-a', 10), archive('worker-a', 20), spawn('worker-a', 30)]
  }));
  assert.equal(rows[0].status, 'running');
  assert.equal(rows[0].startedAt, 10);
  assert.equal(rows[0].endedAt, null);
});

test('links the card by assignee and takes usage from the ledger figures', () => {
  const rows = buildTempHistory(base({
    log: [spawn('worker-a', 1), archive('worker-a', 2)],
    usage: { 'worker-a': { tokens: 500, usd: 1.5 } },
    tasks: [{ id: 't-9', assignee: 'worker-a' }, { id: 't-1', assignee: 'god' }]
  }));
  assert.equal(rows[0].taskId, 't-9');
  assert.equal(rows[0].tokens, 500);
});

test('filters by project, status and range; totals follow the filter', () => {
  const rows = buildTempHistory(base({
    registry: {
      'worker-a': { project: 'p1' }, 'worker-b': { project: 'p2' }, 'worker-c': { project: 'p1' }
    },
    log: [
      spawn('worker-a', NOW - H), archive('worker-a', NOW - H / 2),
      spawn('worker-b', NOW - H), archive('worker-b', NOW - H / 2),
      spawn('worker-c', NOW - 30 * H), archive('worker-c', NOW - 29 * H)
    ],
    doneAt: { 'worker-a': NOW - H / 2 },
    usage: {
      'worker-a': { tokens: 10, usd: 1 }, 'worker-b': { tokens: 20, usd: 2 }, 'worker-c': { tokens: 40, usd: 4 }
    }
  }));
  const f = (o) => filterTempHistory(rows, { project: '', status: '', range: 'all', ...o }, NOW);
  assert.equal(f({}).length, 3);
  assert.equal(f({ range: '24h' }).length, 2);
  assert.deepEqual(f({ project: 'p1' }).map((r) => r.workerId).sort(), ['worker-a', 'worker-c']);
  assert.deepEqual(f({ status: 'done' }).map((r) => r.workerId), ['worker-a']);
  assert.deepEqual(totalTempHistory(f({ project: 'p1', range: '24h' })), { count: 1, tokens: 10, usd: 1 });
});

test('firstLine of nothing is empty', () => {
  assert.equal(firstLine(undefined), '');
});

test('ledger fold: lifetime tokens survive a counter reset', async () => {
  const t = new CostLedgerTotals();
  const row = (inp, usd) => JSON.stringify({ agent_id: 'w', session_id: 's', input: inp, output: 0, cache_read: 0, cache_creation: 0, usd });
  t.consume(Buffer.from([row(100, 1), row(300, 3), row(50, 0.5)].join('\n') + '\n'));
  t.recompute();
  t.warm = true;
  assert.equal(t.tokensFor('w'), 350);
});
