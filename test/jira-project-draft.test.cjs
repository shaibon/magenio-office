'use strict';

// The Jira-project form's COMMIT BOUNDARY: everything the user typed becomes
// the persisted record in `bindingFromDraft` and nowhere else. It lives in a
// plain .ts module (this repo has no DOM test harness) precisely so these
// rules can be exercised for real rather than grepped for in JSX.

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { bindingFromDraft, draftFromBinding, emptyDraft } =
  loadTs('src/renderer/src/components/jiraProjectDraft.ts');
const { validateTrelloIntake } = loadTs('src/shared/trelloIntake.ts');

function draft(over) {
  return {
    isNew: true,
    key: 'burd',
    repo: '/repos/burda',
    baseBranch: 'main',
    agents: [],
    enabled: true,
    trelloUrl: 'https://trello.com/b/AbCd1234/my-board',
    ...over
  };
}

function trello(over) {
  return {
    boardShortLink: 'AbCd1234',
    boardLabel: 'My Board',
    intakeLists: ['Approvati'],
    enabled: true,
    ...over
  };
}

test('a binding with no Trello source is unchanged (regression)', () => {
  const b = bindingFromDraft(draft({ trelloUrl: '' }));
  assert.equal('trello' in b, false, 'a project with no Trello source must not grow one');
  assert.equal(b.key, 'BURD');
  assert.equal(b.repo, '/repos/burda');
  assert.equal(b.agents, undefined, 'no agents still means "any agent"');
});

test('intake list names are trimmed before they are stored', () => {
  // "Da fare " is exactly what pasting a list name out of Trello produces.
  // Stored untrimmed it reaches god and then misses the mission's "match list
  // names EXACTLY" rule forever — a silent zero-intake, no error anywhere the
  // user looks.
  const b = bindingFromDraft(draft({ trello: trello({ intakeLists: ['Da fare ', ' Approvati'] }) }));
  assert.deepEqual(b.trello.intakeLists, ['Da fare', 'Approvati']);
});

test('the blank line a trailing newline leaves behind is dropped, not saved and not rejected', () => {
  const b = bindingFromDraft(draft({ trello: trello({ intakeLists: ['Da fare', ''] }) }));
  assert.deepEqual(b.trello.intakeLists, ['Da fare']);
  // The form validates the BINDING, so the same trailing newline no longer
  // produces "Intake list names cannot be empty." pointing at an invisible line.
  assert.equal(validateTrelloIntake(b.trello), null);
});

test('an all-blank list normalizes to none, which the validator still rejects', () => {
  const b = bindingFromDraft(draft({ trello: trello({ intakeLists: ['', '   '] }) }));
  assert.deepEqual(b.trello.intakeLists, []);
  assert.ok(validateTrelloIntake(b.trello), 'a Trello source with no usable list must not save');
});

test('the board short link and label are trimmed too, and the rest of the source is carried through', () => {
  const b = bindingFromDraft(draft({
    trello: trello({ boardShortLink: ' AbCd1234 ', boardLabel: ' My Board ', enabled: false })
  }));
  assert.equal(b.trello.boardShortLink, 'AbCd1234');
  assert.equal(b.trello.boardLabel, 'My Board');
  assert.equal(b.trello.enabled, false, 'the intake switch must survive normalization');
});

test('the non-Trello fields keep their existing normalization', () => {
  const b = bindingFromDraft(draft({ key: '  burd  ', repo: ' /repos/burda ', baseBranch: ' main ', agents: ['god'] }));
  assert.equal(b.key, 'BURD');
  assert.equal(b.repo, '/repos/burda');
  assert.equal(b.baseBranch, 'main');
  assert.deepEqual(b.agents, ['god']);
});

test('draftFromBinding → bindingFromDraft round-trips a stored binding', () => {
  const stored = {
    key: 'BURD', repo: '/repos/burda', baseBranch: 'main',
    agents: ['god'], enabled: true, trello: trello()
  };
  assert.deepEqual(bindingFromDraft(draftFromBinding(stored)), stored);
});

test('emptyDraft has no Trello source and produces a bare binding', () => {
  const d = emptyDraft();
  assert.equal(d.trello, undefined);
  assert.equal(d.trelloUrl, '');
  assert.equal('trello' in bindingFromDraft(d), false);
});
