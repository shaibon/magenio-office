'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const {
  TRELLO_SHORTLINK_RE,
  parseTrelloBoardUrl,
  jiraLabelForCard,
  trelloCardUrl,
  normalizeIntakeLists,
  validateTrelloIntake
} = loadTs('src/shared/trelloIntake.ts');

function binding(over) {
  return {
    boardShortLink: '781LrPy9',
    boardLabel: 'BurdaStyle',
    intakeLists: ['Approvati'],
    enabled: true,
    ...over
  };
}

test('TRELLO_SHORTLINK_RE accepts an 8-char alphanumeric short link', () => {
  assert.ok(TRELLO_SHORTLINK_RE.test('781LrPy9'));
  assert.ok(TRELLO_SHORTLINK_RE.test('kOGceP5w'));
});

test('TRELLO_SHORTLINK_RE rejects wrong lengths and punctuation', () => {
  assert.equal(TRELLO_SHORTLINK_RE.test('781LrPy'), false);
  assert.equal(TRELLO_SHORTLINK_RE.test('781LrPy99'), false);
  assert.equal(TRELLO_SHORTLINK_RE.test('781LrP-9'), false);
});

test('parseTrelloBoardUrl extracts the short link with and without the slug', () => {
  assert.equal(parseTrelloBoardUrl('https://trello.com/b/781LrPy9/burdastyle'), '781LrPy9');
  assert.equal(parseTrelloBoardUrl('https://trello.com/b/781LrPy9'), '781LrPy9');
  assert.equal(parseTrelloBoardUrl('https://trello.com/b/781LrPy9/burdastyle/'), '781LrPy9');
  assert.equal(parseTrelloBoardUrl('https://www.trello.com/b/781LrPy9/x?filter=due'), '781LrPy9');
  assert.equal(parseTrelloBoardUrl('  https://trello.com/b/781LrPy9/x  '), '781LrPy9');
});

test('parseTrelloBoardUrl refuses a card URL, a foreign host and junk', () => {
  assert.equal(parseTrelloBoardUrl('https://trello.com/c/781LrPy9/42-card'), null);
  assert.equal(parseTrelloBoardUrl('https://evil.example.com/b/781LrPy9/x'), null);
  assert.equal(parseTrelloBoardUrl('https://trello.com/b/short/x'), null);
  assert.equal(parseTrelloBoardUrl('not a url'), null);
  assert.equal(parseTrelloBoardUrl(''), null);
});

test('jiraLabelForCard and trelloCardUrl produce the agreed shapes', () => {
  assert.equal(jiraLabelForCard('abcd1234'), 'trello-abcd1234');
  assert.equal(trelloCardUrl('abcd1234'), 'https://trello.com/c/abcd1234');
});

test('normalizeIntakeLists trims every name — the mission matches list names EXACTLY', () => {
  // A trailing space is what a paste out of Trello produces. Stored untrimmed
  // it is a permanent silent zero-intake: the name never matches on the board.
  assert.deepEqual(normalizeIntakeLists(['Da fare ', ' Approvati', '\tIn corso\t']), ['Da fare', 'Approvati', 'In corso']);
});

test('normalizeIntakeLists drops the blank line a trailing newline leaves behind', () => {
  assert.deepEqual(normalizeIntakeLists(['Da fare', '']), ['Da fare']);
  assert.deepEqual(normalizeIntakeLists(['Da fare', '   ', 'Approvati']), ['Da fare', 'Approvati']);
});

test('normalizeIntakeLists survives an absent or all-blank list, leaving validation to say so', () => {
  assert.deepEqual(normalizeIntakeLists(undefined), []);
  assert.deepEqual(normalizeIntakeLists(['', '  ']), []);
  // …and an empty result is still a rejected binding, so blanks are never a
  // silent way to save a Trello source with no lists at all.
  assert.ok(validateTrelloIntake(binding({ intakeLists: normalizeIntakeLists(['', '  ']) })));
});

test('normalized names pass the validator that rejected them untrimmed', () => {
  // The asymmetry this closes: validateTrelloIntake trims for CHECKING, so it
  // accepted "Da fare " and returned nothing normalized. After normalization
  // what is validated and what is stored are the same strings.
  const raw = ['Da fare ', ''];
  assert.ok(validateTrelloIntake(binding({ intakeLists: raw })), 'a blank line is rejected before normalization');
  assert.equal(validateTrelloIntake(binding({ intakeLists: normalizeIntakeLists(raw) })), null);
});

test('normalizeIntakeLists does not hide a duplicate that only whitespace separated', () => {
  const names = normalizeIntakeLists(['Da fare', 'Da fare ']);
  assert.ok(validateTrelloIntake(binding({ intakeLists: names })), 'trimming must not smuggle a duplicate past the validator');
});

test('validateTrelloIntake accepts a well-formed binding', () => {
  assert.equal(validateTrelloIntake(binding()), null);
});

test('validateTrelloIntake rejects a missing or malformed short link', () => {
  assert.ok(validateTrelloIntake(binding({ boardShortLink: '' })));
  assert.ok(validateTrelloIntake(binding({ boardShortLink: 'nope' })));
});

test('validateTrelloIntake requires at least one intake list', () => {
  assert.ok(validateTrelloIntake(binding({ intakeLists: [] })));
});

test('validateTrelloIntake rejects an empty list name', () => {
  assert.ok(validateTrelloIntake(binding({ intakeLists: ['Approvati', '   '] })));
});

test('validateTrelloIntake rejects duplicate list names case-insensitively', () => {
  const error = validateTrelloIntake(binding({ intakeLists: ['Da fare', 'DA FARE'] }));
  assert.ok(typeof error === 'string' && error.length > 0);
});
