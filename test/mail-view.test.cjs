'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { mailCounts, selectMessages, triageReason, ageLabel } = loadTs('src/shared/mailView.ts');

const tri = (projectKey, via = 'rule', confidence = null) => ({ category: 'bug', urgency: 'normal', projectKey, via, confidence });
const msgs = [
  { id: 1, receivedAt: 3, triage: tri('BURD') },
  { id: 2, receivedAt: 2, triage: tri('BURD', 'jira-key') },
  { id: 3, receivedAt: 1, triage: tri('VAI') },
  { id: 4, receivedAt: 0, triage: tri(null, 'none') },
  { id: 5, receivedAt: 0, triage: null }
];

test('counts per project, with untriaged mail in Da assegnare', () => {
  assert.deepEqual(mailCounts(msgs), { total: 5, unassigned: 2, byProject: [['BURD', 2], ['VAI', 1]] });
});

test('selection filters by bucket', () => {
  assert.equal(selectMessages(msgs, { kind: 'all' }).length, 5);
  assert.deepEqual(selectMessages(msgs, { kind: 'unassigned' }).map((m) => m.id), [4, 5]);
  assert.deepEqual(selectMessages(msgs, { kind: 'project', key: 'BURD' }).map((m) => m.id), [1, 2]);
});

test('triage reason names how the project was chosen', () => {
  assert.deepEqual(triageReason(tri('A', 'model', 0.874)), { key: 'mail.reason.model', pct: 87 });
  assert.deepEqual(triageReason(tri('A', 'model', null)), { key: 'mail.reason.modelNoConf' });
  assert.equal(triageReason(tri('A', 'jira-key')).key, 'mail.reason.jiraKey');
  assert.equal(triageReason(tri('A', 'rule')).key, 'mail.reason.rule');
  assert.equal(triageReason(tri('A', 'manual')).key, 'mail.reason.manual');
  assert.equal(triageReason(tri(null, 'none')).key, 'mail.reason.none');
  assert.equal(triageReason(null).key, 'mail.reason.pending');
});

test('age label', () => {
  assert.equal(ageLabel(1000, 1000 + 30_000), 'now');
  assert.equal(ageLabel(0, 5 * 60_000), '5m');
  assert.equal(ageLabel(0, 3 * 3600_000), '3h');
  assert.equal(ageLabel(0, 72 * 3600_000), '3d');
  assert.equal(ageLabel(10, 0), 'now'); // clock skew never goes negative
});

test('paging: merge keeps older pages, de-duplicates and sorts newest first', () => {
  const { mergePage, nextCursor, pageMayHaveMore, countLabel, MAIL_PAGE_SIZE } = loadTs('src/shared/mailView.ts');
  const m = (id, receivedAt) => ({ id, receivedAt, triage: null });
  const first = [m(3, 30), m(2, 20)];
  const older = [m(1, 10)];
  const merged = mergePage(first, older);
  assert.deepEqual(merged.map((x) => x.id), [3, 2, 1]);
  // refreshing page one (with a new arrival and a duplicate) keeps the older page
  assert.deepEqual(mergePage(merged, [m(4, 40), m(3, 30)]).map((x) => x.id), [4, 3, 2, 1]);
  assert.equal(nextCursor(merged), 10);
  assert.equal(nextCursor([]), undefined);
  assert.equal(pageMayHaveMore(new Array(MAIL_PAGE_SIZE)), true);
  assert.equal(pageMayHaveMore(new Array(MAIL_PAGE_SIZE - 1)), false);
  assert.equal(countLabel(200, true), '200+');
  assert.equal(countLabel(5, false), '5');
});
