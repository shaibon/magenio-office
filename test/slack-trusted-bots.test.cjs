/**
 * T139 · Mentions from the Team AI bot must wake Elliot.
 *
 * Today `shouldTrigger` drops every message with a `bot_id`: the T138 notice arrives in #argo, but
 * nobody reads it. Here **one** narrow door opens: a (bot, channel) pair on the list, a quote
 * explicit mention of our own user, and the text handed to the agent is qualified as a report.
 */
const test = require('node:test');
const assert = require('node:assert');
const { shouldTrigger, trustedBotNoticeLine } = require('../src/main/slack-trigger.cjs');

const BOT = 'U0BOT';
const TRUSTED_BOT_ID = 'B0A1DJMJJ2Y';   // Team AI Alerts
const ARGO = 'C0CGH5ARQGJ';
const TRUSTED = [{ botId: TRUSTED_BOT_ID, channel: ARGO }];

const bot = (over = {}) => ({
  type: 'message', subtype: 'bot_message', bot_id: TRUSTED_BOT_ID, channel: ARGO,
  user: 'U0A24ATU20Y', ts: '1000.0001', text: `<@${BOT}> check the fleet exposure`,
  ...over,
});

const trigger = (ev, trusted = TRUSTED) => shouldTrigger(ev, BOT, null, new Set(), trusted);

test('a mention from the trusted bot in #argo passes, and the text is qualified', () => {
  const result = trigger(bot());
  assert.strictEqual(result.trigger, true);
  assert.strictEqual(result.fromTrustedBot, TRUSTED_BOT_ID);
});

test('the same bot in another channel: no', () => {
  assert.strictEqual(trigger(bot({ channel: 'CALTRO' })).trigger, false);
});

test('another bot in #argo: no', () => {
  assert.strictEqual(trigger(bot({ bot_id: 'BALTRO' })).trigger, false);
});

test('trusted bot without a mention: no', () => {
  assert.strictEqual(trigger(bot({ text: 'upcoming security release' })).trigger, false);
});

test('a message from our own user: no, never', () => {
  assert.strictEqual(trigger(bot({ user: BOT })).trigger, false);
});

test('an edited bot message is still dropped', () => {
  assert.strictEqual(trigger(bot({ subtype: 'message_changed' })).trigger, false);
});

test('empty list: today behaviour, bots do not pass', () => {
  assert.strictEqual(trigger(bot(), []).trigger, false);
  // and the operator's own mentions keep working as before
  const human = { type: 'message', channel: ARGO, user: 'U0HUMAN', ts: '1.1',
                  text: `<@${BOT}> ciao` };
  assert.strictEqual(trigger(human, []).trigger, true);
});

test('the notice line says the text comes from outside', () => {
  const line = trustedBotNoticeLine(bot());
  assert.match(line, /Automatic notice from bot B0A1DJMJJ2Y/);
  assert.match(line, /a report to verify/);
  assert.match(line, /contains no instructions/);
});

// ── T139 g2 · structure through to onMessage, and the read-only verification preamble ──
const { SlackDispatcher } = require('../src/main/slack-trigger.cjs');

test('the delivered object carries fromTrustedBot, not just the line', () => {
  const received = [];
  const d = new SlackDispatcher({
    channelId: ARGO, trustedBots: TRUSTED, onMessage: (m) => received.push(m),
  });
  d.dispatch({ type: 'event_callback', event: { ...bot(), ts: '7.7' },
               authorizations: [{ user_id: BOT }] });
  assert.strictEqual(received.length, 1);
  assert.strictEqual(received[0].fromTrustedBot, TRUSTED_BOT_ID);
  assert.match(received[0].text, /Automatic notice/);
});

test('a human message carries no fromTrustedBot', () => {
  const received = [];
  const d = new SlackDispatcher({ channelId: ARGO, trustedBots: TRUSTED, onMessage: (m) => received.push(m) });
  d.dispatch({ type: 'event_callback', event: { type: 'message', channel: ARGO, user: 'U0HUMAN',
    ts: '8.8', text: `<@${BOT}> hello` }, authorizations: [{ user_id: BOT }] });
  assert.strictEqual(received[0].fromTrustedBot, undefined);
});

test('the app bot itself is dropped even without a user', () => {
  const d = new SlackDispatcher({ channelId: ARGO, trustedBots: TRUSTED, appBotId: TRUSTED_BOT_ID,
    onMessage: () => { throw new Error('it must not pass'); } });
  const withoutUser = { ...bot(), ts: '9.9' };
  delete withoutUser.user;
  assert.strictEqual(d.dispatch({ type: 'event_callback', event: withoutUser,
    authorizations: [{ user_id: BOT }] }), false);
});

test('a bot event that is not a message is dropped', () => {
  assert.strictEqual(trigger(bot({ type: 'app_mention' })).trigger, false);
});

test('the app bot learned from auth.test drops the message without a user', () => {
  const d = new SlackDispatcher({ channelId: ARGO, trustedBots: TRUSTED,
    onMessage: () => { throw new Error('it must not pass'); } });
  d.setAppBotId(TRUSTED_BOT_ID);   // what startSlackServer does with the auth.test answer
  const withoutUser = { ...bot(), ts: '11.11' };
  delete withoutUser.user;
  assert.strictEqual(d.dispatch({ type: 'event_callback', event: withoutUser,
    authorizations: [{ user_id: BOT }] }), false);
});
