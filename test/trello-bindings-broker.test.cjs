'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { IntegrationBroker } = loadTs('src/main/integrationBroker.ts');

function makeBroker(bindings) {
  return new IntegrationBroker({
    getRecord: () => undefined,
    getSecret: () => undefined,
    getJiraBindings: () => ({
      bindings,
      poll: { pollIntervalMs: 300000, assigneeFilter: 'currentUser', statusFilter: 'To Do' }
    })
  });
}

async function read(broker) {
  const token = broker.grant('god', []);
  const res = await fetch(`${broker.url()}/jira-bindings`, { headers: { 'x-md-broker-token': token } });
  assert.equal(res.status, 200);
  return res.json();
}

test('GET /jira-bindings carries the trello source through to god untouched', async () => {
  const trello = { boardShortLink: '781LrPy9', boardLabel: 'BurdaStyle', intakeLists: ['Approvati'], enabled: true };
  const broker = makeBroker([{ key: 'BURD', repo: '/r/burd', baseBranch: 'develop', enabled: true, trello }]);
  await broker.start();
  const body = await read(broker);
  assert.deepEqual(body.bindings[0].trello, trello);
  broker.stop();
});

test('a binding with no trello source produces the same shape as before', async () => {
  const broker = makeBroker([{ key: 'BRAVI', repo: '/r/bravi', baseBranch: 'develop', enabled: true }]);
  await broker.start();
  const body = await read(broker);
  assert.equal('trello' in body.bindings[0], false);
  broker.stop();
});
