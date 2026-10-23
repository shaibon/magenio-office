'use strict';
// t-193: god may open a NEW Slack message only in the project's configured alert
// channel. Everything else stays thread-only (CLAUSE-1).
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const https = require('node:https');
const { EventEmitter } = require('node:events');
const loadTs = require('./load-ts.cjs');

const { postSlackReply, postSlackAlert, SlackReplyServer } = loadTs('src/main/slack.ts');
const { alertChannelFor, isSlackChannelId } = loadTs('src/shared/jiraProjects.ts');

/** Fake slack.com: records every chat.postMessage body, answers ok + ts. */
function fakeSlack(t) {
  const posts = [];
  const orig = https.request;
  https.request = (_opts, cb) => {
    const req = new EventEmitter();
    let body = '';
    req.write = (c) => { body += c; };
    req.setTimeout = () => {};
    req.destroy = () => {};
    req.end = () => {
      posts.push(JSON.parse(body));
      const res = new EventEmitter();
      cb(res);
      res.emit('data', Buffer.from(JSON.stringify({ ok: true, ts: '1700000000.000100' })));
      res.emit('end');
    };
    return req;
  };
  t.after(() => { https.request = orig; });
  return posts;
}

const bindings = [
  { key: 'BURD', repo: '/r', baseBranch: 'develop', enabled: true, slackAlertChannel: 'C0ALERTS123' },
  { key: 'OFF', repo: '/r', baseBranch: 'develop', enabled: false, slackAlertChannel: 'C0DISABLED1' },
  { key: 'BAD', repo: '/r', baseBranch: 'develop', enabled: true, slackAlertChannel: 'not a channel' },
  { key: 'NONE', repo: '/r', baseBranch: 'develop', enabled: true },
  { key: 'RISTO', repo: '/r', baseBranch: 'develop', enabled: true, slackChannels: ['CBCT8Q00Z', 'C0SECOND99'] },
  { key: 'OVER', repo: '/r', baseBranch: 'develop', enabled: true, slackChannels: ['CBCT8Q00Z'], slackAlertChannel: 'C0ALERTS123' },
  { key: 'OFFCH', repo: '/r', baseBranch: 'develop', enabled: false, slackChannels: ['CBCT8Q00Z'] }
];

test('alertChannelFor resolves only enabled, well-formed bindings', () => {
  assert.equal(alertChannelFor(bindings, 'burd'), 'C0ALERTS123');
  assert.equal(alertChannelFor(bindings, 'RISTO'), 'CBCT8Q00Z', 'fallback to slackChannels[0]');
  assert.equal(alertChannelFor(bindings, 'OVER'), 'C0ALERTS123', 'slackAlertChannel overrides');
  for (const k of ['OFF', 'OFFCH', 'BAD', 'NONE', 'MISSING']) assert.equal(alertChannelFor(bindings, k), null, k);
  assert.equal(alertChannelFor(undefined, 'BURD'), null);
  assert.equal(isSlackChannelId('C03G9FGU2RE'), true);
  assert.equal(isSlackChannelId('general'), false);
});

test('postSlackAlert posts a root message only in the configured channel; postSlackReply still needs a thread', async (t) => {
  const posts = fakeSlack(t);
  const bad = await postSlackAlert({ botToken: 'x', channel: 'C0OTHER999', configuredChannel: 'C0ALERTS123', text: 'hi' });
  assert.deepEqual(bad, { ok: false, error: 'channel is not the project alert channel' });
  assert.equal((await postSlackAlert({ botToken: 'x', channel: 'C0ALERTS123', configuredChannel: null, text: 'hi' })).ok, false);
  assert.equal(posts.length, 0, 'nothing reached Slack');
  const ok = await postSlackAlert({ botToken: 'x', channel: 'C0ALERTS123', configuredChannel: 'C0ALERTS123', text: 'disk full' });
  assert.deepEqual(ok, { ok: true, error: undefined, ts: '1700000000.000100' });
  assert.deepEqual(posts, [{ channel: 'C0ALERTS123', text: 'disk full' }], 'root post: no thread_ts');
  const noThread = await postSlackReply({ botToken: 'x', channel: 'C0ALERTS123', thread_ts: '  ', text: 'hi' });
  assert.equal(noThread.ok, false, 'CLAUSE-1 guard unchanged');
  assert.equal(posts.length, 1);
});

function call(port, path, headers, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const r = http.request({ host: '127.0.0.1', port, path, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...headers } }, (res) => {
      let raw = ''; res.on('data', (c) => { raw += c; });
      res.on('end', () => resolve({ status: res.statusCode, json: raw ? JSON.parse(raw) : {} }));
    });
    r.on('error', reject); r.end(body);
  });
}

test('/alert needs the reply token AND a writable broker capability; channel must match', async (t) => {
  const posts = fakeSlack(t);
  const srv = new SlackReplyServer({
    token: 'rt', getBotToken: () => 'xoxb-secret',
    alertChannelFor: (p) => alertChannelFor(bindings, p),
    isBrokerWriter: (tok) => tok === 'god-cap'
  });
  const { port } = await srv.start();
  t.after(() => srv.stop());
  const H = { 'x-md-reply-token': 'rt' };
  const G = { ...H, 'x-md-broker-token': 'god-cap' };
  assert.equal((await call(port, '/alert', {}, { project: 'BURD', text: 't' })).status, 401, 'no reply token');
  assert.equal((await call(port, '/alert', H, { project: 'BURD', text: 't' })).status, 403, 'no broker capability');
  assert.equal((await call(port, '/alert', { ...H, 'x-md-broker-token': 'readonly-pm' }, { project: 'BURD', text: 't' })).status, 403);
  assert.equal((await call(port, '/alert', G, { project: 'NONE', text: 't' })).status, 403, 'project without alert channel');
  const wrong = await call(port, '/alert', G, { project: 'BURD', channel: 'C0OTHER999', text: 't' });
  assert.equal(wrong.status, 403);
  assert.match(wrong.json.error, /not the project alert channel/);
  assert.equal(posts.length, 0);
  const ok = await call(port, '/alert', G, { project: 'BURD', text: 'down' });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json, { ok: true, ts: '1700000000.000100', channel: 'C0ALERTS123' });
  assert.ok(!JSON.stringify(ok.json).includes('xoxb'), 'bot token never returned');
  assert.equal((await call(port, '/alert', G, { project: 'BURD', channel: 'C0ALERTS123', text: 'again' })).status, 200);
  assert.equal(posts.length, 2);
  // /reply is unchanged: still needs a thread.
  assert.equal((await call(port, '/reply', H, { channel: 'C0ALERTS123', text: 'x' })).status, 400);
});

test('/alert rejects an n8n-only broker capability (403, nothing posted)', async (t) => {
  const posts = fakeSlack(t);
  const { IntegrationBroker } = loadTs('src/main/integrationBroker.ts');
  const broker = new IntegrationBroker({ getRecord: () => undefined, getSecret: () => undefined });
  const srv = new SlackReplyServer({
    token: 'rt', getBotToken: () => 'xoxb-secret',
    alertChannelFor: (p) => alertChannelFor(bindings, p),
    isBrokerWriter: (tok) => broker.hasWritableCapability(tok)
  });
  const { port } = await srv.start();
  t.after(() => srv.stop());
  const hdr = (tok) => ({ 'x-md-reply-token': 'rt', 'x-md-broker-token': tok });
  const body = { project: 'BURD', text: 'x' };
  assert.equal((await call(port, '/alert', hdr(broker.grantN8n('agent')), body)).status, 403);
  assert.equal((await call(port, '/alert', hdr(broker.grant('god', [])), body)).status, 200, 'a god capability still works');
  assert.equal(posts.length, 1);
});
