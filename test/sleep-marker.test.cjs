'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { SleepMarker } = loadTs('src/main/sleepMarker.ts');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-sleep-marker-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
const file = path.join(dir, 'hibernated-agents.json');

test('t-283 L2: the app-owned marker records the session an agent slept with, per hive root', () => {
  let root = '/hive/a';
  const m = new SleepMarker(file, () => root);
  assert.equal(m.sessionOf('pam'), undefined);
  m.set('pam', 'sess-1');
  assert.equal(m.sessionOf('pam'), 'sess-1');
  root = '/hive/b';
  assert.equal(m.sessionOf('pam'), undefined, 'another hive does not see it');
  root = '/hive/a';
  m.clear('pam');
  assert.equal(m.sessionOf('pam'), undefined);
  assert.equal((fs.statSync(file).mode & 0o077), 0, 'private file');
});

test('t-283 L2: corrupt / foreign marker content, prototype keys and a missing root read as nobody asleep', () => {
  const m = new SleepMarker(file, () => '/hive/a');
  fs.writeFileSync(file, 'not json');
  assert.equal(m.sessionOf('pam'), undefined);
  fs.writeFileSync(file, JSON.stringify(['x']));
  assert.equal(m.sessionOf('pam'), undefined);
  fs.writeFileSync(file, JSON.stringify({ '/hive/a': { pam: 7 } }));
  assert.equal(m.sessionOf('pam'), undefined, 'non-string session');
  assert.equal(m.sessionOf('__proto__'), undefined);
  assert.equal(m.sessionOf('constructor'), undefined);
  const none = new SleepMarker(file, () => null);
  none.set('pam', 's'); // no root: ignored
  assert.equal(none.sessionOf('pam'), undefined);
});
