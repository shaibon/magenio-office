'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { ThumbRegistry } = loadTs('src/shared/thumbRegistry.ts');

function make() {
  const revoked = [];
  let n = 0;
  const reg = new ThumbRegistry(() => `blob:${++n}`, (u) => revoked.push(u));
  return { reg, revoked };
}

test('release revokes once and is idempotent', () => {
  const { reg, revoked } = make();
  const u = reg.add({});
  reg.release(u);
  reg.release(u);
  reg.release(undefined);
  assert.deepEqual(revoked, [u]);
  assert.equal(reg.size, 0);
});

test('releaseAll (unmount / tab switch) revokes everything still held, not what was released', () => {
  const { reg, revoked } = make();
  const a = reg.add({}), b = reg.add({}), c = reg.add({});
  reg.release(b); // removed by the user
  reg.releaseAll();
  assert.deepEqual(revoked.sort(), [a, b, c].sort());
  assert.equal(revoked.length, 3);
  assert.equal(reg.size, 0);
});

test('a paste whose save rejects can release in finally without leaking', async () => {
  const { reg, revoked } = make();
  const paste = async (save) => {
    const url = reg.add({});
    let kept = false;
    try { kept = (await save()).ok; } finally { if (!kept) reg.release(url); }
  };
  await assert.rejects(paste(async () => { throw new Error('ipc down'); }));
  await paste(async () => ({ ok: false }));
  assert.equal(revoked.length, 2);
  assert.equal(reg.size, 0);
});
