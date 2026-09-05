'use strict';

// src/renderer/src/hooks/useResolvedRepoNames.ts — extracted from
// FullscreenTerminal.tsx so every place an agent's bare name shows (Command
// Center pickers, restore toasts, detail headers) can tag it with the SAME
// reliably-resolved project label the roster already groups by, PLUS (once
// this file's second job landed) the Jira project key that repo is bound to,
// if any — so "Pam" on two different projects, each bound to its own Jira
// key, reads as "Pam - BURD · burdastyle" vs "Pam - BRAVI · bravifarmacie".
// Only the pure functions are unit-tested here — `useResolvedRepoNames`
// itself needs a mounted React tree to exercise (it drives the async git
// lookup and Jira-bindings fetch that fill the module-level caches these
// read from).

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { basename, repoKeyOf, repoLabelOf, projectTag, projectTagCompact, jiraKeyFor, bindingMatches } =
  loadTs('src/renderer/src/hooks/useResolvedRepoNames.ts');

function binding(overrides) {
  return { key: 'BURD', repo: '/repo/burdastyle', baseBranch: 'develop', enabled: true, ...overrides };
}

function agent(overrides) {
  return { id: 'a1', name: 'Andy', cwd: '/Users/shaibon/www/burdastyle', isGod: false, ...overrides };
}

test('basename splits on both / and \\\\, so a Windows path works too', () => {
  assert.equal(basename('/Users/shaibon/www/burdastyle'), 'burdastyle');
  assert.equal(basename('C:\\work\\burdastyle'), 'burdastyle');
  assert.equal(basename('burdastyle'), 'burdastyle');
});

test('repoLabelOf falls back to agent.project before the git root resolves', () => {
  assert.equal(repoLabelOf(agent({ project: 'BurdaStyle' })), 'BurdaStyle');
});

test('repoLabelOf falls back to basename(cwd) when there is no project either', () => {
  assert.equal(repoLabelOf(agent({ project: undefined })), 'burdastyle');
});

test('repoLabelOf never returns empty, even for an agent with no cwd and no project', () => {
  assert.equal(repoLabelOf(agent({ cwd: '', project: undefined })), 'unknown');
});

test('repoKeyOf falls back to the raw cwd before the git root resolves', () => {
  assert.equal(repoKeyOf(agent()), '/Users/shaibon/www/burdastyle');
});

test('projectTag is empty for the god agent — there is only ever one, never ambiguous', () => {
  assert.equal(projectTag(agent({ isGod: true })), '');
});

test('projectTag is " · <label>" for everyone else', () => {
  assert.equal(projectTag(agent({ project: 'BurdaStyle' })), ' · BurdaStyle');
});

test('projectTagCompact is empty for the god agent', () => {
  assert.equal(projectTagCompact(agent({ isGod: true })), '');
});

test('projectTagCompact falls back to the repo label while no Jira key is resolved', () => {
  assert.equal(projectTagCompact(agent({ project: 'BurdaStyle' })), ' · BurdaStyle');
  assert.equal(projectTagCompact(agent({ project: undefined })), ' · burdastyle');
});

test('projectTagCompact never duplicates "KEY · repoLabel" — the dense-list variant is shorter than the full tag', () => {
  // The bindings cache is module-private and unloaded here, so the observable
  // contract is: when the key is missing the compact form equals the full form;
  // when a key exists (rendered through the same helper in real mounts) it is
  // strictly shorter because it drops the duplicated repo label.
  const a = agent({ project: 'BurdaStyle' });
  assert.equal(projectTagCompact(a), projectTag(a));
  assert.ok(projectTag(a).length >= projectTagCompact(a).length);
});

test('two same-named agents on different projects produce different tags', () => {
  const andyA = agent({ id: 'andy-1', cwd: '/repo/burdastyle', project: 'BurdaStyle' });
  const andyB = agent({ id: 'andy-2', cwd: '/repo/bravifarmacie', project: 'BravaFarmacie' });
  assert.notEqual(`${andyA.name}${projectTag(andyA)}`, `${andyB.name}${projectTag(andyB)}`);
});

test('jiraKeyFor returns undefined before the bindings list has loaded — never throws, never guesses', () => {
  // A fresh module load never had a mounted React tree drive
  // useResolvedRepoNames, so the module-private bindings cache is still
  // null here — exactly the "not fetched yet" state a real first render is in.
  assert.equal(jiraKeyFor(agent()), undefined);
});

test('projectTag has no " - KEY" segment while the Jira key is unresolved', () => {
  assert.equal(projectTag(agent({ project: 'BurdaStyle' })), ' · BurdaStyle');
});

test('bindingMatches: enabled + same repo root + unscoped agents matches anyone in that repo', () => {
  assert.equal(bindingMatches(binding({ agents: undefined }), '/repo/burdastyle', 'pam-1'), true);
  assert.equal(bindingMatches(binding({ agents: [] }), '/repo/burdastyle', 'pam-1'), true);
});

test('bindingMatches: scoped to specific agents excludes anyone not in that list', () => {
  assert.equal(bindingMatches(binding({ agents: ['pam-1', 'dwight-1'] }), '/repo/burdastyle', 'pam-1'), true);
  assert.equal(bindingMatches(binding({ agents: ['pam-1', 'dwight-1'] }), '/repo/burdastyle', 'toby-1'), false);
});

test('bindingMatches: a disabled binding never matches, even with the right repo and agent', () => {
  assert.equal(bindingMatches(binding({ enabled: false }), '/repo/burdastyle', 'pam-1'), false);
});

test('bindingMatches: a different repo root never matches, Jira key aside', () => {
  assert.equal(bindingMatches(binding({ repo: '/repo/burdastyle' }), '/repo/bravifarmacie', 'pam-1'), false);
});

test('the real-world case this feature exists for: same agent id, two different (enabled) bindings for two different repos, produce two different keys', () => {
  const bravi = binding({ key: 'BRAVI', repo: '/repo/bravifarmacie', agents: ['pam-2'] });
  const burd = binding({ key: 'BURD', repo: '/repo/burdastyle', agents: ['pam-1'] });
  assert.equal(bindingMatches(burd, '/repo/burdastyle', 'pam-1'), true);
  assert.equal(bindingMatches(bravi, '/repo/burdastyle', 'pam-1'), false);
  assert.equal(bindingMatches(bravi, '/repo/bravifarmacie', 'pam-2'), true);
  assert.equal(bindingMatches(burd, '/repo/bravifarmacie', 'pam-2'), false);
});
