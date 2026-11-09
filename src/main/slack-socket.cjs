'use strict';
/**
 * Slack Socket Mode client — receives Events API payloads over a WebSocket that
 * the app opens OUTBOUND (apps.connections.open + an app-level `xapp-` token), so
 * no public URL or tunnel is needed.
 *
 * Protocol: every envelope carrying an `envelope_id` is acked by sending
 * `{ envelope_id }` back; `events_api` payloads are the same `event_callback`
 * bodies the HTTP path receives and go to `onEvent`; a `disconnect` envelope or a
 * socket close triggers a reconnect with capped backoff. A heartbeat pings every
 * 30 s and drops a socket that delivered nothing for 75 s (half-open connection).
 *
 * Plain CJS with injectable `openUrl` / `createSocket` so it is testable with a
 * mock socket (same shape as slack-trigger.cjs). The app token is never logged
 * and never appears in an error message.
 */
const https = require('node:https');

const BACKOFF_START_MS = 1000;
const BACKOFF_MAX_MS = 30000;
// Liveness: a half-open TCP connection (network drop, sleep) never emits 'close', so
// the client pings and terminates a socket that has produced no frame at all lately.
const PING_EVERY_MS = 30000;
const STALE_AFTER_MS = 75000;

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
   *           setTimer?: Function, clearTimer?: Function,
   *           setBeat?: Function, clearBeat?: Function, now?: () => number,
   *           onLog?: (event: object) => void }} opts
   */
  constructor(opts) {
    this.appToken = opts.appToken;
    this.onEvent = opts.onEvent;
    this.openUrl = opts.openUrl || openConnectionUrl;
    this.createSocket = opts.createSocket || defaultCreateSocket;
    this.setTimer = opts.setTimer || setTimeout;
    this.clearTimer = opts.clearTimer || clearTimeout;
    this.setBeat = opts.setBeat || setInterval;
    this.clearBeat = opts.clearBeat || clearInterval;
    this.now = opts.now || Date.now;
    this.onLog = opts.onLog || (() => {});
    this.beat = null;
    this.lastSeen = 0;
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
    this.stopBeat();
    if (this.timer) { this.clearTimer(this.timer); this.timer = null; }
    this.closeSocket();
  }

  log(phase, reason) {
    // Never the token or the wss URL: only the phase and a short reason.
    try { this.onLog({ kind: 'slack-socket', phase, ...(reason ? { reason } : {}) }); } catch { /* logging is best-effort */ }
  }

  stopBeat() { if (this.beat) { this.clearBeat(this.beat); this.beat = null; } }

  startBeat(gen) {
    this.stopBeat();
    this.lastSeen = this.now();
    this.beat = this.setBeat(() => {
      if (gen !== this.generation || this.stopped) return this.stopBeat();
      if (this.now() - this.lastSeen > STALE_AFTER_MS) {
        // Silent socket: no frame, ping or pong. Drop it hard (a half-open close() would wait for a peer that is gone).
        this.generation++;
        const s = this.socket;
        this.socket = null;
        try { if (s) (typeof s.terminate === 'function' ? s.terminate() : s.close()); } catch { /* noop */ }
        this.stopBeat();
        this.log('lost', 'stale');
        this.scheduleReconnect(0);
        return;
      }
      try { if (this.socket && typeof this.socket.ping === 'function') this.socket.ping(); } catch { /* close will follow */ }
    }, PING_EVERY_MS);
    if (this.beat && typeof this.beat.unref === 'function') this.beat.unref();
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
    const seen = () => { if (gen === this.generation) this.lastSeen = this.now(); };
    socket.on('open', () => {
      if (gen !== this.generation) return;
      this.connected = true; this.backoff = BACKOFF_START_MS;
      this.startBeat(gen);
      this.log('connected');
    });
    socket.on('message', (data) => { if (gen === this.generation) { this.lastSeen = this.now(); this.handleFrame(data); } });
    socket.on('pong', seen);
    socket.on('ping', seen);
    socket.on('close', () => { if (gen === this.generation) { this.log('lost', 'close'); this.scheduleReconnect(); } });
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
      this.stopBeat();
      this.closeSocket();
      this.connected = false;
      this.log('lost', 'disconnect');
      this.scheduleReconnect(0);
    } else if (env.type === 'events_api' && env.payload) {
      try { this.onEvent(env.payload); } catch { /* delivery is best-effort */ }
    }
  }

  scheduleReconnect(delay) {
    if (this.stopped || this.timer) return;
    this.connected = false;
    this.stopBeat();
    this.closeSocket();
    const wait = delay === undefined ? this.backoff : delay;
    if (delay === undefined) this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX_MS);
    this.timer = this.setTimer(async () => {
      this.timer = null;
      if (this.stopped) return;
      this.log('reconnecting');
      const r = await this.connect();
      if (!r.ok && !this.stopped) this.scheduleReconnect();
    }, wait);
  }
}

module.exports = { SlackSocketClient, openConnectionUrl, BACKOFF_START_MS, BACKOFF_MAX_MS, PING_EVERY_MS, STALE_AFTER_MS };
