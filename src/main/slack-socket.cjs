'use strict';
/**
 * Slack Socket Mode client — receives Events API payloads over a WebSocket that
 * the app opens OUTBOUND (apps.connections.open + an app-level `xapp-` token), so
 * no public URL or tunnel is needed.
 *
 * Protocol: every envelope carrying an `envelope_id` is acked by sending
 * `{ envelope_id }` back; `events_api` payloads are the same `event_callback`
 * bodies the HTTP path receives and go to `onEvent`; a `disconnect` envelope or a
 * socket close triggers a reconnect with capped backoff.
 *
 * Plain CJS with injectable `openUrl` / `createSocket` so it is testable with a
 * mock socket (same shape as slack-trigger.cjs). The app token is never logged
 * and never appears in an error message.
 */
const https = require('node:https');

const BACKOFF_START_MS = 1000;
const BACKOFF_MAX_MS = 30000;

/** apps.connections.open → wss URL. Resolves `{ ok, url?, error? }`. */
function openConnectionUrl(appToken) {
  return new Promise((resolve) => {
    const req = https.request({
      method: 'POST',
      hostname: 'slack.com',
      path: '/api/apps.connections.open',
      headers: { authorization: `Bearer ${appToken}`, 'content-type': 'application/x-www-form-urlencoded', 'content-length': 0 }
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          const j = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          resolve(j.ok === true && typeof j.url === 'string' ? { ok: true, url: j.url } : { ok: false, error: j.error || 'open failed' });
        } catch { resolve({ ok: false, error: 'bad response from Slack' }); }
      });
    });
    req.on('error', (e) => resolve({ ok: false, error: e && e.message ? e.message : 'network error' }));
    req.end();
  });
}

function defaultCreateSocket(url) {
  const WebSocket = require('ws');
  return new WebSocket(url);
}

class SlackSocketClient {
  /**
   * @param {{ appToken: string, onEvent: (payload: object) => void,
   *           openUrl?: (t: string) => Promise<{ok:boolean,url?:string,error?:string}>,
   *           createSocket?: (url: string) => object,
   *           setTimer?: Function, clearTimer?: Function }} opts
   */
  constructor(opts) {
    this.appToken = opts.appToken;
    this.onEvent = opts.onEvent;
    this.openUrl = opts.openUrl || openConnectionUrl;
    this.createSocket = opts.createSocket || defaultCreateSocket;
    this.setTimer = opts.setTimer || setTimeout;
    this.clearTimer = opts.clearTimer || clearTimeout;
    this.socket = null;
    this.timer = null;
    this.stopped = true;
    this.connected = false;
    this.backoff = BACKOFF_START_MS;
    this.generation = 0; // guards against a stale socket's events after a reconnect
  }

  /** First connect. Resolves `{ ok, error? }`; a failed first open is not retried
   *  (the caller surfaces a bad token), later drops reconnect on their own. */
  async start() {
    if (!this.stopped) return { ok: false, error: 'already running' };
    if (!this.appToken) return { ok: false, error: 'missing app-level token' };
    this.stopped = false;
    const r = await this.connect();
    if (!r.ok) this.stopped = true;
    return r;
  }

  stop() {
    this.stopped = true;
    this.connected = false;
    this.generation++;
    if (this.timer) { this.clearTimer(this.timer); this.timer = null; }
    this.closeSocket();
  }

  closeSocket() {
    const s = this.socket;
    this.socket = null;
    try { if (s) s.close(); } catch { /* noop */ }
  }

  async connect() {
    const gen = ++this.generation;
    const opened = await this.openUrl(this.appToken);
    if (this.stopped || gen !== this.generation) return { ok: false, error: 'stopped' };
    if (!opened.ok || !opened.url) return { ok: false, error: opened.error || 'open failed' };
    let socket;
    try { socket = this.createSocket(opened.url); }
    catch { return { ok: false, error: 'websocket failed' }; }
    this.socket = socket;
    socket.on('open', () => { if (gen === this.generation) { this.connected = true; this.backoff = BACKOFF_START_MS; } });
    socket.on('message', (data) => { if (gen === this.generation) this.handleFrame(data); });
    socket.on('close', () => { if (gen === this.generation) this.scheduleReconnect(); });
    socket.on('error', () => { /* a close always follows; never surface the URL */ });
    return { ok: true };
  }

  handleFrame(data) {
    let env;
    try { env = JSON.parse(typeof data === 'string' ? data : Buffer.from(data).toString('utf8')); }
    catch { return; }
    if (!env || typeof env !== 'object') return;
    // Ack FIRST, before any processing, so a slow/throwing handler can't trigger Slack's redelivery.
    if (typeof env.envelope_id === 'string' && env.envelope_id) {
      try { this.socket && this.socket.send(JSON.stringify({ envelope_id: env.envelope_id })); } catch { /* socket gone; close will reconnect */ }
    }
    if (env.type === 'disconnect') {
      // Slack is rotating/refusing this connection — move to a fresh one right away.
      this.generation++;
      this.closeSocket();
      this.connected = false;
      this.scheduleReconnect(0);
    } else if (env.type === 'events_api' && env.payload) {
      try { this.onEvent(env.payload); } catch { /* delivery is best-effort */ }
    }
  }

  scheduleReconnect(delay) {
    if (this.stopped || this.timer) return;
    this.connected = false;
    this.closeSocket();
    const wait = delay === undefined ? this.backoff : delay;
    if (delay === undefined) this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX_MS);
    this.timer = this.setTimer(async () => {
      this.timer = null;
      if (this.stopped) return;
      const r = await this.connect();
      if (!r.ok && !this.stopped) this.scheduleReconnect();
    }, wait);
  }
}

module.exports = { SlackSocketClient, openConnectionUrl, BACKOFF_START_MS, BACKOFF_MAX_MS };
