/**
 * T139 g4 · The two main-side joints, read in the source.
 *
 * Two mutations used to stay green: the provenance not passed to the message builder, and the app bot
 * not handed to the filter after `auth.test`. They are this card's security boundary, and a test that
 * reads the source sees them even when the code compiles.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf8');

/** The `onMessage` block that builds the message for the renderer. */
function ipcBlock() {
  const start = main.indexOf('const ipcMsg = buildSlackIpcMessage({');
  assert.notStrictEqual(start, -1, 'buildSlackIpcMessage must be called from onMessage');
  return main.slice(start, main.indexOf('\n    });', start));
}

test('onMessage passes the provenance to the message builder', () => {
  const block = ipcBlock();
  // The first occurrence builds the message: it must be the message field, not an invented value.
  // The second one drives the preamble choice.
  const matched = block.match(/fromTrustedBot:\s*[^,\n]+/g) || [];
  assert.deepStrictEqual(matched,
    ['fromTrustedBot: m.fromTrustedBot', 'fromTrustedBot: m.fromTrustedBot'],
    'both must come from the received message');
  assert.ok(block.indexOf('fromTrustedBot:') < block.indexOf('files:'),
    'the provenance precedes the files: it is a builder argument, not an internal detail');
});

test('after auth.test the app bot reaches the filter', () => {
  const start = main.indexOf("fetch('https://slack.com/api/auth.test'");
  assert.notStrictEqual(start, -1, 'auth.test must be called');
  const after = main.slice(start, start + 800);
  assert.match(after, /slackServer\.setAppBotId\(body\.bot_id\)/,
    'without this, the app-bot anti-loop is not active');
});
