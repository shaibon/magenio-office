'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { createOriginResolver } = loadTs('src/shared/originResolver.ts');
const { eligibleWriters, writerChips } = loadTs('src/shared/vaultWriters.ts');

const tick = () => new Promise((r) => setImmediate(r));

test('one lookup per cwd however many panels ask, and never more than `limit` at once', async () => {
  let calls = 0, active = 0, peak = 0;
  const r = createOriginResolver(async (cwd) => {
    calls++; active++; peak = Math.max(peak, active);
    await tick();
    active--;
    return `origin:${cwd}`;
  }, { limit: 3 });
  const cwds = Array.from({ length: 40 }, (_, i) => `/w/${i}`);
  // four project panels each ask for the whole roster, twice (a re-render)
  const answers = await Promise.all(
    [...Array(4)].flatMap(() => [...cwds, ...cwds].map((c) => r.get(c)))
  );
  assert.equal(calls, 40);
  assert.ok(peak <= 3, `peak ${peak}`);
  assert.equal(answers.every((a) => a.startsWith('origin:')), true);
});

test('a throwing lookup resolves to null and does not block the queue', async () => {
  const r = createOriginResolver(async (cwd) => { if (cwd === '/bad') throw new Error('boom'); return 'o'; }, { limit: 1 });
  const [a, b] = await Promise.all([r.get('/bad'), r.get('/good')]);
  assert.equal(a, null);
  assert.equal(b, 'o');
});

test('results are cached until the ttl expires', async () => {
  let calls = 0, t = 0;
  const r = createOriginResolver(async () => { calls++; return 'o'; }, { ttlMs: 100, now: () => t });
  await r.get('/a'); await r.get('/a');
  assert.equal(calls, 1);
  t = 101;
  await r.get('/a');
  assert.equal(calls, 2);
});

test('real roster shape: each project lists its own Angela (origins as reported by the Boss)', async () => {
  const origin = {
    bravi: 'git@bitbucket.org:magenio/bravifarmacie.git', burd: 'git@bitbucket.org:magenio/burdastyle.git',
    vai: 'git@bitbucket.org:magenio/sardiniaecommerce-m2.git', risto: 'git@bitbucket.org:magenio/ristosubito-m2.git'
  };
  const cwdOrigin = {
    '/w/angela-muvdk1xn': origin.bravi, '/w/angela-muvdjjel': origin.burd,
    '/w/angela-muvdkfxe': origin.vai, '/w/angela-mtld33i7': origin.risto
  };
  const r = createOriginResolver(async (cwd) => cwdOrigin[cwd] ?? null, { limit: 2 });
  const agents = [];
  for (const [cwd, o] of Object.entries(cwdOrigin)) {
    agents.push({ id: cwd.split('/').pop(), name: 'Angela', archived: false, origin: await r.get(cwd) });
    assert.equal(o, agents[agents.length - 1].origin);
  }
  for (const o of Object.values(origin)) {
    const opts = eligibleWriters(o, [], agents);
    assert.equal(opts.length, 1);
    assert.equal(writerChips(o, [opts[0].id], agents)[0].state, 'ok');
  }
});
