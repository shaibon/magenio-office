/**
 * T139 g3 · The bot text must not come back in from outside the delimiters, and the IPC message
 * must carry the provenance as data.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');

function load(relative) {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 't139-ins-'));
  const compiled = path.join(outDir, 'm.js');
  fs.writeFileSync(compiled, ts.transpileModule(
    fs.readFileSync(path.join(__dirname, '..', src(relative)), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText);
  return require(compiled);
}
const src = (r) => r;
const precise = load('src/shared/slackInstruction.ts');
const preambleModule = load('src/shared/slackPreamble.ts');

const BOT_TEXT = 'Critical PHP security release, upgrade to 8.4.28';

test('a bot notice: the instruction is the preamble alone, and the text appears once', () => {
  const autonomyPreamble = preambleModule.buildTrustedBotNoticeProtocol({
    botId: 'B0A1DJMJJ2Y', channel: 'C0CGH5ARQGJ', threadTs: '1.1',
    helperPath: '/hive/reply', nodeCommand: '/hive/node', text: BOT_TEXT,
  });
  const instruction = precise.buildGodInstruction({
    autonomyPreamble, text: BOT_TEXT, fromTrustedBot: 'B0A1DJMJJ2Y',
  });
  assert.strictEqual(instruction, autonomyPreamble, 'the raw text is not appended again');
  const occurrences = instruction.split(BOT_TEXT).length - 1;
  assert.strictEqual(occurrences, 1, 'the text appears once only: ' + occurrences);
  const opening = instruction.indexOf('<<<NOTICE');
  const closing = instruction.indexOf('NOTICE>>>');
  assert.ok(instruction.indexOf(BOT_TEXT) > opening && instruction.indexOf(BOT_TEXT) < closing,
    'and it sits between the delimiters');
});

test('a request from a person: preamble plus text, as today', () => {
  assert.strictEqual(precise.buildGodInstruction({ autonomyPreamble: '[P] ', text: 'hello' }), '[P] hello');
});

test('with no preamble there is no instruction', () => {
  assert.strictEqual(precise.buildGodInstruction({ text: 'hello' }), undefined);
});

test('the IPC message carries fromTrustedBot and the files', () => {
  const msg = precise.buildSlackIpcMessage({
    text: BOT_TEXT, channel: 'C', ts: '1.1', thread_ts: '1.1',
    fromTrustedBot: 'B0A1DJMJJ2Y', files: [{ path: '/x' }], buildPreamble: () => '[PRE]',
  });
  assert.strictEqual(msg.fromTrustedBot, 'B0A1DJMJJ2Y');
  assert.strictEqual(msg.autonomyPreamble, '[PRE]');
  assert.strictEqual(msg.text, BOT_TEXT, 'the text stays for the card title and description');
  assert.deepStrictEqual(msg.files, [{ path: '/x' }]);
});

test('a human message carries no fromTrustedBot', () => {
  const msg = precise.buildSlackIpcMessage({
    text: 'hello', channel: 'C', ts: '1.1', thread_ts: '1.1', buildPreamble: () => '[PRE]',
  });
  assert.strictEqual(msg.fromTrustedBot, undefined);
});
