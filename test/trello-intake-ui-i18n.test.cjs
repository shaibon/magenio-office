'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const LOCALES = ['en', 'zh-CN', 'ar'];
const KEYS = [
  'trelloTitle', 'trelloAdd', 'trelloRemove', 'trelloBoardUrl', 'trelloBoardUrlHint',
  'trelloBoardLabel', 'trelloLists', 'trelloListsHint', 'trelloEnabled', 'trelloBadUrl'
];

function read(locale) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src/renderer/src/i18n/locales', `${locale}.json`), 'utf8'));
}

for (const locale of LOCALES) {
  test(`${locale} has every new jiraProjects string`, () => {
    const block = read(locale).jiraProjects;
    assert.ok(block, `${locale} has no jiraProjects block`);
    for (const key of KEYS) {
      assert.ok(typeof block[key] === 'string' && block[key].length > 0, `${locale} is missing jiraProjects.${key}`);
    }
  });
}

test('the registry parses the board URL and does not ask for a raw id', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/src/components/JiraProjectsRegistry.tsx'), 'utf8');
  assert.match(src, /parseTrelloBoardUrl/, 'the board URL must be parsed, not pasted as an id');
  assert.match(src, /trelloBoardUrl/);
  assert.match(src, /intakeLists/);
});

test('the form validates the binding it is about to save, not the raw draft', () => {
  // The normalization itself is exercised for real in jira-project-draft.test.cjs.
  // What this pins is the ORDER: `bindingFromDraft` must run FIRST, so what is
  // validated and what is persisted are the same strings — validating the raw
  // draft instead is how a trailing newline produced "Intake list names cannot
  // be empty." pointing at an invisible blank line.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/src/components/JiraProjectsRegistry.tsx'), 'utf8');
  const save = src.slice(src.indexOf('const onSave'), src.indexOf('const persistPoll'));
  assert.ok(save.length > 0, 'onSave not found');
  assert.ok(
    save.indexOf('bindingFromDraft(draft)') >= 0 &&
    save.indexOf('bindingFromDraft(draft)') < save.indexOf('validateTrelloIntake('),
    'the draft must be converted to a binding before it is validated'
  );
  assert.match(save, /validateTrelloIntake\(binding\.trello\)/, 'the normalized binding is what gets validated');
  assert.match(save, /jiraProjectsClient\.save\(binding\)/, 'and the same object is what gets saved');
});

test('the list textarea still keeps every typed line', () => {
  // Deliberate: filtering blanks while the user types makes a trailing newline
  // silently delete a name mid-edit. Normalization belongs at the commit
  // boundary, not in onChange.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/src/components/JiraProjectsRegistry.tsx'), 'utf8');
  assert.match(src, /intakeLists: e\.target\.value\.split\('\\n'\)/, 'the onChange must not trim or filter');
});
