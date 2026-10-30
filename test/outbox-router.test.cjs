'use strict';

/** t-280: the outbox router must never archive a message as .sent unless it landed somewhere. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');

async function floor(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-outbox-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'god', name: 'Michael', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'creed', name: 'Creed', provider: 'claude', cwd: home });
  const agents = path.join(hive.root(), 'agents');
  const out = (id) => path.join(agents, id, 'outbox');
  const inbox = (id) => fs.readdirSync(path.join(agents, id, 'inbox')).filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(agents, id, 'inbox', f), 'utf8')));
  const drops = () => fs.readFileSync(path.join(hive.root(), 'log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.kind === 'drop');
  const put = (name, content) => fs.writeFileSync(path.join(out('creed'), name), typeof content === 'string' ? content : JSON.stringify(content));
  const ls = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir) : []);
  return { hive, out, inbox, drops, put, ls };
}

test('a message with no id and no from is delivered with a generated id and the folder as sender', async (t) => {
  const { hive, out, inbox, put, ls } = await floor(t);
  put('m.json', { to: 'god', act: 'done', subject: 's', body: 'b', conversation: 'c', in_reply_to: 'x' });
  hive.routeOnce();
  const [m] = inbox('god');
  assert.equal(m.from, 'creed');
  assert.match(m.id, /^\d{4}-\d\d-\d\dT/);
  assert.deepEqual(ls(path.join(out('creed'), '.sent')), ['m.json']);
  assert.deepEqual(ls(path.join(out('creed'), '.failed')), []);
});

test('malformed JSON is kept in .failed with the reason, logged as a drop, and the sender is told', async (t) => {
  const { hive, out, inbox, drops, put, ls } = await floor(t);
  put('bad.json', '{ not json');
  hive.routeOnce();
  assert.deepEqual(ls(path.join(out('creed'), '.sent')).filter((f) => f.includes('bad')), [], 'never in .sent');
  const failed = ls(path.join(out('creed'), '.failed'));
  assert.ok(failed.includes('bad.json') && failed.includes('bad.json.reason.txt'));
  assert.match(fs.readFileSync(path.join(out('creed'), '.failed', 'bad.json.reason.txt'), 'utf8'), /malformed-json/);
  assert.ok(drops().some((d) => d.reason === 'malformed-json' && d.from === 'creed'));
  const notice = inbox('creed').find((m) => /NOT DELIVERED/.test(m.subject));
  assert.ok(notice && /malformed-json/.test(notice.subject));
  assert.equal(inbox('god').length, 0);
});

test('non-object JSON (null, array, number) is a clean failure, not a silent bad- archive', async (t) => {
  const { hive, out, drops, put, ls } = await floor(t);
  put('a.json', 'null'); put('b.json', '[1,2]'); put('c.json', '42');
  hive.routeOnce();
  assert.deepEqual(ls(path.join(out('creed'), '.failed')).filter((f) => f.endsWith('.json')).sort(), ['a.json', 'b.json', 'c.json']);
  assert.equal(drops().filter((d) => d.reason === 'not-a-message-object').length, 3);
});

test('self-addressed mail (previously dropped with no trace) fails loudly', async (t) => {
  const { hive, out, drops, put, ls } = await floor(t);
  put('self.json', { to: 'creed', subject: 'me', body: 'x' });
  hive.routeOnce();
  assert.ok(ls(path.join(out('creed'), '.failed')).includes('self.json'));
  assert.ok(drops().some((d) => d.reason === 'self-addressed'));
});

test('unknown recipient still lands (bounced to god), is logged, and is archived as sent', async (t) => {
  const { hive, out, inbox, drops, put, ls } = await floor(t);
  put('u.json', { to: 'nobody-here', subject: 'hi', body: 'x' });
  hive.routeOnce();
  assert.ok(ls(path.join(out('creed'), '.sent')).includes('u.json'));
  assert.ok(inbox('god').some((m) => /undeliverable/.test(m.subject)));
  assert.ok(drops().some((d) => d.reason === 'no-inbox'));
});

test('no bounce destination (god inbox gone) is reported as such, not as hop-cap', async (t) => {
  const { hive, out, drops, put, ls } = await floor(t);
  fs.rmSync(path.join(hive.root(), 'agents', 'god', 'inbox'), { recursive: true });
  put('u.json', { to: 'nobody', body: 'x' });
  hive.routeOnce();
  assert.ok(ls(path.join(out('creed'), '.failed')).includes('u.json'));
  assert.match(fs.readFileSync(path.join(out('creed'), '.failed', 'u.json.reason.txt'), 'utf8'), /no-god-inbox/);
  assert.ok(drops().some((d) => d.reason === 'no-god-inbox'));
  assert.ok(!drops().some((d) => d.reason === 'hop-cap'));
});
