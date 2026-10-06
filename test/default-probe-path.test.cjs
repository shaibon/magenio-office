'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { defaultProbePath } = require('./load-ts.cjs')('src/shared/integrations.ts');

test('Bitbucket Cloud probes `user` (host match, any record id)', () => {
  assert.equal(defaultProbePath({ id: 'bitbucket', baseUrl: 'https://api.bitbucket.org/2.0' }), 'user');
  assert.equal(defaultProbePath({ id: 'my-bb', baseUrl: 'https://API.Bitbucket.org/2.0/' }), 'user');
});

test('jira keeps `myself`; other hosts and bad urls probe the root', () => {
  assert.equal(defaultProbePath({ id: 'jira', baseUrl: 'https://x.atlassian.net/rest/api/3' }), 'myself');
  assert.equal(defaultProbePath({ id: 'other', baseUrl: 'https://example.com/rest/api/3' }), '');
  assert.equal(defaultProbePath({ id: 'bitbucket', baseUrl: 'https://evil.test/api.bitbucket.org' }), '');
  assert.equal(defaultProbePath({ id: 'bitbucket', baseUrl: 'not a url' }), '');
});
