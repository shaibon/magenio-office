'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { selectionWakes } = loadTs('src/renderer/src/hooks/wakeOnSelect.ts');

test('55 restored agents selected one after another during the restore wake none; a click afterwards wakes one', () => {
  let last = null;
  let woken = 0;
  for (let i = 0; i < 55; i++) {
    if (selectionWakes(last, `a${i}`, true)) woken++;
    last = `a${i}`;
  }
  if (selectionWakes(last, 'a0', true)) woken++; // the restore puts the user's old selection back
  assert.equal(woken, 0);
  assert.equal(selectionWakes('a0', 'a7', false), true, 'a real click wakes');
  assert.equal(selectionWakes('a7', 'a7', false), false, 'same selection is not a new event');
  assert.equal(selectionWakes('a7', null, false), false);
});

test('the select hook consults the restore flag and still records what it saw', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/src/hooks/useHive.ts'), 'utf8');
  assert.match(src, /selectionWakes\(last, id, isRestoringTeam\(\)\);\s*\n\s*if \(id\) last = id;/);
});
