'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const J = loadTs('src/shared/jiraProjects.ts');
const { bindingFromDraft, draftFromBinding } = loadTs('src/renderer/src/components/jiraProjectDraft.ts');

test('glitchtip binding: normalize, validate, draft round-trip', () => {
  assert.deepEqual(J.normalizeGlitchtip({ enabled: true, projects: [' Bravi-Prod ', 'bravi-prod', ''] }), { enabled: true, projects: ['bravi-prod'] });
  assert.equal(J.normalizeGlitchtip({ enabled: true, projects: [] }), undefined);
  assert.equal(J.normalizeGlitchtip(undefined), undefined);
  const other = { key: 'BRAVI', repo: '/r', baseBranch: 'main', enabled: true, glitchtip: { enabled: true, projects: ['bravi-prod'] } };
  assert.match(J.validateGlitchtip({ enabled: true, projects: ['bravi-prod'] }, [other]), /already bound to BRAVI/);
  assert.match(J.validateGlitchtip({ enabled: true, projects: ['bad slug!'] }, []), /not a GlitchTip/);
  assert.equal(J.validateGlitchtip({ enabled: true, projects: ['ok-slug'] }, [other]), null);
  const d = draftFromBinding(other);
  assert.equal(d.glitchtip, 'bravi-prod');
  assert.deepEqual(bindingFromDraft({ ...d, glitchtip: 'a, B;a', glitchtipEnabled: false }).glitchtip, { enabled: false, projects: ['a', 'b'] });
  assert.equal(bindingFromDraft({ ...d, glitchtip: '' }).glitchtip, undefined);
});
