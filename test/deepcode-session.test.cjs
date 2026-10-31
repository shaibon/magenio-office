'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { deepcodeProjectCode, latestDeepcodeSession } = loadTs('src/main/deepcodeSession.ts');
const { Hibernator } = loadTs('src/main/hibernation.ts');

const A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

test('project code mirrors the CLI: path separators become dashes, long roots get prefix-hash', () => {
  assert.equal(deepcodeProjectCode('/Users/magenio/HarnessAgents/worktrees/andy-mtidghkl'), '-Users-magenio-HarnessAgents-worktrees-andy-mtidghkl');
  const long = '/Users/magenio/HarnessAgents/worktrees/' + 'x'.repeat(60);
  assert.match(deepcodeProjectCode(long), /^x{47}-[0-9a-f]{16}$/);
  assert.equal(deepcodeProjectCode('C:\\work\\a', 'win32'), 'C-work-a');
});

test('the newest thread in the agent project dir is its session; other dirs and junk are ignored', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-home-'));
  try {
    const cwd = '/Users/x/wt/andy-1';
    const dir = path.join(home, '.deepcode', 'projects', deepcodeProjectCode(cwd));
    const other = path.join(home, '.deepcode', 'projects', deepcodeProjectCode('/Users/x/wt/andy-2'));
    fs.mkdirSync(dir, { recursive: true }); fs.mkdirSync(other, { recursive: true });
    assert.equal(latestDeepcodeSession(cwd, home), undefined, 'no thread yet');
    fs.writeFileSync(path.join(dir, `${A}.jsonl`), '{}\n');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'x');
    fs.writeFileSync(path.join(other, `${B}.jsonl`), '{}\n');
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(path.join(dir, `${A}.jsonl`), old, old);
    assert.equal(latestDeepcodeSession(cwd, home), A);
    fs.writeFileSync(path.join(dir, `${B}.jsonl`), '{}\n');
    assert.equal(latestDeepcodeSession(cwd, home), B, 'newest wins');
    assert.equal(latestDeepcodeSession('/Users/x/wt/nobody', home), undefined);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

function hib(over) {
  return new Hibernator({
    ptyFor: () => 'pty-1', recipeFor: () => ({}), sessionFor: () => undefined, isHibernated: () => false,
    setHibernated: () => true, killPty: () => true, teardownLight: () => {}, notify: () => {}, inboxCount: () => 0, ...over
  });
}

test('a refused manual hibernate names the reason; no refusal when it can go', () => {
  assert.equal(hib({}).whyNot('a'), 'no-session');
  assert.equal(hib({ ptyFor: () => undefined }).whyNot('a'), 'not-running');
  assert.equal(hib({ recipeFor: () => undefined }).whyNot('a'), 'no-recipe');
  assert.equal(hib({ isHibernated: () => true }).whyNot('a'), 'already-asleep');
  assert.equal(hib({ sessionFor: () => A }).whyNot('a'), null);
});

test('wiring: sessions come from resumableSession (deepcode discovery), the IPC returns a reason, the strip shows it', () => {
  const root = path.join(__dirname, '..');
  const main = fs.readFileSync(path.join(root, 'src/main/index.ts'), 'utf8');
  assert.match(main, /sessionFor: \(id\) => resumableSession\(id\)/);
  assert.match(main, /hasSession: !!resumableSession\(agentId\)/);
  assert.match(main, /\(a\.provider \?\? recipeOpts\?\.provider\) !== 'deepcode'\) return undefined;/);
  assert.match(main, /hive\.recordSession\(id, found\)/);
  assert.match(main, /agent:hibernateNow[\s\S]{0,1400}hibernator\.whyNot\(agentId\)/);
  const strip = fs.readFileSync(path.join(root, 'src/renderer/src/components/AgentControlStrip.tsx'), 'utf8');
  assert.match(strip, /agentControl\.hibernateWhy\.\$\{res\?\.reason \?\? 'failed'\}/);
  for (const l of ['en', 'zh-CN', 'ar']) {
    const why = JSON.parse(fs.readFileSync(path.join(root, `src/renderer/src/i18n/locales/${l}.json`), 'utf8')).agentControl.hibernateWhy;
    for (const k of ['no-session', 'not-running', 'no-recipe', 'already-asleep', 'frozen', 'not-allowed', 'not-found', 'failed']) assert.ok(why[k], `${l}.${k}`);
  }
});
