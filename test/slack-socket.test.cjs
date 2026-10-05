'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const { SlackSocketClient, BACKOFF_START_MS } = require('../src/main/slack-socket.cjs');
const { SlackDispatcher } = require('../src/main/slack-trigger.cjs');

let failures = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); }
  catch (err) { failures++; console.log(`  ✗ ${name}\n     ${err.message}`); }
}

class MockSocket extends EventEmitter {
  constructor(url) { super(); this.url = url; this.sent = []; this.closed = false; }
  send(s) { this.sent.push(JSON.parse(s)); }
  close() { this.closed = true; }
  frame(obj) { this.emit('message', JSON.stringify(obj)); }
}

/** Client wired to mocks; timers are captured so tests fire them by hand. */
function harness(onEvent = () => {}, openResults = []) {
  const sockets = [];
  const timers = [];
  const opened = [];
  const client = new SlackSocketClient({
    appToken: 'xapp-test',
    onEvent,
    openUrl: async (tok) => { opened.push(tok); return openResults.shift() || { ok: true, url: `wss://mock/${opened.length}` }; },
    createSocket: (url) => { const s = new MockSocket(url); sockets.push(s); return s; },
    setTimer: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; },
    clearTimer: (t) => { t.cleared = true; }
  });
  return { client, sockets, timers, opened };
}

const BOT = 'U0BOT';
const cb = (ts, extra = {}) => ({
  type: 'event_callback',
  authorizations: [{ user_id: BOT }],
  event: { type: 'message', channel: 'C1', ts, text: `<@${BOT}> hi`, ...extra }
});

(async () => {
  console.log('slack socket mode tests');

  await test('start opens a connection with the app token and connects the socket', async () => {
    const h = harness();
    const r = await h.client.start();
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(h.opened, ['xapp-test']);
    assert.strictEqual(h.sockets[0].url, 'wss://mock/1');
    h.sockets[0].emit('open');
    assert.strictEqual(h.client.connected, true);
  });

  await test('missing token and failed open are reported without a socket', async () => {
    const none = new SlackSocketClient({ appToken: '', onEvent() {} });
    assert.strictEqual((await none.start()).ok, false);
    const h = harness(() => {}, [{ ok: false, error: 'invalid_auth' }]);
    const r = await h.client.start();
    assert.deepStrictEqual(r, { ok: false, error: 'invalid_auth' });
    assert.strictEqual(h.sockets.length, 0);
  });

  await test('every envelope with an envelope_id is acked, and events_api payloads delivered', async () => {
    const got = [];
    const h = harness((p) => got.push(p));
    await h.client.start();
    const s = h.sockets[0];
    s.frame({ type: 'hello' }); // no envelope_id → no ack
    s.frame({ envelope_id: 'e1', type: 'events_api', payload: cb('1.1') });
    s.frame({ envelope_id: 'e2', type: 'slash_commands', payload: {} }); // acked, not delivered
    assert.deepStrictEqual(s.sent, [{ envelope_id: 'e1' }, { envelope_id: 'e2' }]);
    assert.strictEqual(got.length, 1);
  });

  await test('ack is sent even when the event handler throws', async () => {
    const h = harness(() => { throw new Error('boom'); });
    await h.client.start();
    h.sockets[0].frame({ envelope_id: 'e1', type: 'events_api', payload: cb('1.1') });
    assert.deepStrictEqual(h.sockets[0].sent, [{ envelope_id: 'e1' }]);
  });

  await test('dedup: a redelivered / double-subscribed event reaches onMessage once (same dispatcher path)', async () => {
    const msgs = [];
    const d = new SlackDispatcher({ onMessage: (m) => msgs.push(m) });
    const h = harness((p) => d.dispatch(p));
    await h.client.start();
    const s = h.sockets[0];
    s.frame({ envelope_id: 'a', type: 'events_api', payload: cb('2.2') });
    s.frame({ envelope_id: 'b', type: 'events_api', payload: cb('2.2', { type: 'app_mention' }) });
    s.frame({ envelope_id: 'c', type: 'events_api', payload: cb('2.2') });
    assert.strictEqual(msgs.length, 1);
    assert.strictEqual(msgs[0].text, 'hi'); // mention stripped
    assert.strictEqual(msgs[0].thread_ts, '2.2');
    assert.strictEqual(s.sent.length, 3, 'duplicates are still acked');
  });

  await test('mention filter: a plain message with no mention is dropped but acked', async () => {
    const msgs = [];
    const d = new SlackDispatcher({ onMessage: (m) => msgs.push(m) });
    const h = harness((p) => d.dispatch(p));
    await h.client.start();
    h.sockets[0].frame({ envelope_id: 'a', type: 'events_api', payload: cb('3.3', { text: 'just chatting' }) });
    assert.strictEqual(msgs.length, 0);
    assert.strictEqual(h.sockets[0].sent.length, 1);
  });

  await test('disconnect envelope: acked, old socket closed, reconnects immediately on a fresh URL', async () => {
    const h = harness();
    await h.client.start();
    const s1 = h.sockets[0];
    s1.frame({ envelope_id: 'd1', type: 'disconnect', reason: 'refresh_requested' });
    assert.deepStrictEqual(s1.sent, [{ envelope_id: 'd1' }]);
    assert.strictEqual(s1.closed, true);
    assert.strictEqual(h.timers.length, 1);
    assert.strictEqual(h.timers[0].ms, 0);
    await h.timers[0].fn();
    assert.strictEqual(h.sockets.length, 2);
    assert.strictEqual(h.opened.length, 2);
    // the stale socket's late close must not trigger a second reconnect
    s1.emit('close');
    assert.strictEqual(h.timers.length, 1);
  });

  await test('close: reconnects with exponential backoff, retries a failed open, resets on open', async () => {
    const h = harness(() => {}, [undefined, { ok: false, error: 'ratelimited' }]);
    await h.client.start();
    h.sockets[0].emit('close');
    assert.strictEqual(h.timers[0].ms, BACKOFF_START_MS);
    await h.timers[0].fn(); // second open fails → rescheduled with doubled backoff
    assert.strictEqual(h.sockets.length, 1);
    assert.strictEqual(h.timers[1].ms, BACKOFF_START_MS * 2);
    await h.timers[1].fn(); // third open succeeds
    assert.strictEqual(h.sockets.length, 2);
    h.sockets[1].emit('open');
    h.sockets[1].emit('close');
    assert.strictEqual(h.timers[2].ms, BACKOFF_START_MS, 'backoff reset after a good connection');
  });

  await test('stop: closes the socket, cancels a pending reconnect, ignores late events', async () => {
    const got = [];
    const h = harness((p) => got.push(p));
    await h.client.start();
    const s = h.sockets[0];
    s.emit('close');
    const t = h.timers[0];
    h.client.stop();
    assert.strictEqual(t.cleared, true);
    await t.fn();
    assert.strictEqual(h.sockets.length, 1, 'no reconnect after stop');
    s.frame({ envelope_id: 'x', type: 'events_api', payload: cb('9.9') });
    assert.strictEqual(got.length, 0);
    assert.strictEqual(h.client.connected, false);
  });

  await test('mode switch: stopping the socket then starting the Events API path leaves no socket running', async () => {
    const h = harness();
    await h.client.start();
    h.sockets[0].emit('open');
    h.client.stop();
    assert.strictEqual(h.sockets[0].closed, true);
    assert.strictEqual(h.client.connected, false);
    // restartable (switching back to Socket Mode later)
    assert.strictEqual((await h.client.start()).ok, true);
    assert.strictEqual(h.sockets.length, 2);
  });

  await test('the app token never appears in errors', async () => {
    const h = harness(() => {}, [{ ok: false, error: 'invalid_auth' }]);
    const r = await h.client.start();
    assert.ok(!JSON.stringify(r).includes('xapp-'));
  });

  if (failures) { console.log(`\n${failures} failed`); process.exit(1); }
  console.log('\nall passed');
})();
