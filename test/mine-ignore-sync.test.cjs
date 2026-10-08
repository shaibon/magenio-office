'use strict';

/**
 * `mempalace mine` honours .gitignore negation, so each agent's .gitignore leads
 * with `/*` + `!memory.md` and a mine scans one file instead of the whole dir
 * (qa/ and work/ held mined code copies: 8.7GB palace, 2.7GB / ~7 min per mine).
 * hive.ts (agent birth) and memory.ts (every mine cycle) share ONE
 * ensureMineIgnore; this pins the merge so existing files get the whitelist at
 * the top, once, without losing their other lines.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { mergeMineIgnore, ensureMineIgnore, MINE_IGNORE_LINES } = loadTs('src/main/memory.ts');
const LEAD = '/*\n!memory.md\n';

test('empty file gets whitelist then ignore lines', () => {
  const out = mergeMineIgnore('');
  assert.ok(out.startsWith(LEAD));
  for (const l of MINE_IGNORE_LINES) assert.ok(out.split('\n').includes(l));
  assert.ok(MINE_IGNORE_LINES.includes('.codex/'), 'Codex homes must stay out of the index');
});

test('legacy file: whitelist prepended, custom lines kept', () => {
  const out = mergeMineIgnore('settings.json\nfoo/\n');
  assert.ok(out.startsWith(LEAD + 'settings.json\nfoo/\n'));
});

test('idempotent, and unchanged text is returned as-is', () => {
  const once = mergeMineIgnore('foo/');
  assert.equal(mergeMineIgnore(once), once);
  assert.equal(once.split('\n').filter((l) => l === '/*').length, 1);
});

test('misplaced or duplicated whitelist is moved to the top, once', () => {
  const out = mergeMineIgnore('foo/\n!memory.md\n/*\nbar/\n/*\n');
  assert.ok(out.startsWith(LEAD + 'foo/\nbar/\n'));
  assert.equal(out.split('\n').filter((l) => l === '!memory.md').length, 1);
});

test('ensureMineIgnore writes the file and skips rewriting when current', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-ign-'));
  ensureMineIgnore(dir);
  const f = path.join(dir, '.gitignore');
  const a = fs.readFileSync(f, 'utf8');
  assert.ok(a.startsWith(LEAD));
  const m = fs.statSync(f).mtimeMs;
  ensureMineIgnore(dir);
  assert.equal(fs.statSync(f).mtimeMs, m);
});
