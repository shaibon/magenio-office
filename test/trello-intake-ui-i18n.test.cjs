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
