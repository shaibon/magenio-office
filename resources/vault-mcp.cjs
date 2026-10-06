#!/usr/bin/env node
'use strict';

/**
 * munder-vault — READ-ONLY MCP server over the project's slice of an Obsidian vault.
 *
 * Stdio JSON-RPC (newline-delimited), no dependencies. Launched per agent by the
 * app with:
 *   VAULT_ROOT    absolute vault directory
 *   VAULT_SCOPES  JSON array of folders, relative to VAULT_ROOT, the agent may read:
 *                 its own project folder plus the shared read-only areas
 *
 * Only the project's own writer agent (VAULT_WRITER_AGENT, set by the app from its
 * config) also gets the write tools, below. Everyone else is read-only.
 *
 * Fail-closed: no root, no scopes, or a scope that is not a plain relative path
 * inside the root means nothing is readable. There is no write tool, and no code
 * path here opens a file for writing.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const MAX_READ_BYTES = 200 * 1024;
const MAX_SEARCH_FILE_BYTES = 1024 * 1024;
const MAX_SEARCH_FILES = 5000;
const MAX_LIST_ENTRIES = 500;
const MAX_RESULTS = 50;
const SNIPPET = 220;

class VaultError extends Error {}

/** Real path of `p`, or null when it does not exist / cannot be resolved. */
function real(p) {
  try { return fs.realpathSync(p); } catch { return null; }
}

function within(parent, child) {
  return child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
}

/** A relative path made only of ordinary segments: no absolute, no `..`, no dotfiles
 *  (`.obsidian`, `.git`), no NUL, no backslash tricks. */
function cleanRelative(p) {
  if (typeof p !== 'string' || p.includes('\0') || p.includes('\\')) return null;
  const segs = p.split('/').filter((s) => s !== '' && s !== '.');
  if (path.isAbsolute(p) || segs.some((s) => s === '..' || s.startsWith('.'))) return null;
  return segs.join('/');
}

/** Resolve the configured scopes to real directories. Anything invalid, missing, or
 *  whose real path leaves the vault root is dropped. */
function loadScopes(rootRaw, scopesRaw, writer) {
  const root = rootRaw ? real(rootRaw) : null;
  if (!root) return { root: null, scopes: [] };
  let list = [];
  try { list = JSON.parse(scopesRaw || '[]'); } catch { list = []; }
  const scopes = [];
  for (const s of Array.isArray(list) ? list : []) {
    const rel = cleanRelative(s);
    if (!rel) continue;
    const abs = real(path.join(root, rel));
    if (abs && within(root, abs) && fs.statSync(abs).isDirectory()) scopes.push({ rel, abs });
  }
  const ctx = { root, scopes };
  // The project folder is the FIRST configured scope. A missing one is not an error for
  // its writer: sessionBegin creates it (under lock + snapshot) before the first write.
  const projectRel = cleanRelative(Array.isArray(list) ? list[0] : null);
  // Write capability is explicit and narrow: a named agent, a lock file OUTSIDE the
  // vault (so it is never committed by the snapshot), and the project folder (the
  // first scope). Anything missing means read-only.
  if (writer && writer.agent && writer.lockPath && projectRel && (!real(path.join(root, projectRel)) || (scopes[0] && scopes[0].rel === projectRel))) {
    ctx.write = { agent: String(writer.agent), lockPath: String(writer.lockPath), projectScope: projectRel, session: null };
  }
  return ctx;
}

/** A REAL path (symlinks resolved) with any hidden segment relative to the vault
 *  root, e.g. a visible `notes` symlink that points into `.obsidian`. */
function hiddenReal(ctx, abs) {
  return path.relative(ctx.root, abs).split(path.sep).some((seg) => seg.startsWith('.'));
}

/** Vault-relative path -> { abs, scope }, or throws. The REAL path (symlinks
 *  followed) must sit inside one scope's real directory. */
function resolveInScope(ctx, rel) {
  const clean = cleanRelative(rel);
  if (clean === null || clean === '') throw new VaultError('invalid path');
  const abs = real(path.join(ctx.root, clean));
  if (!abs) throw new VaultError('not found');
  const scope = ctx.scopes.find((s) => within(s.abs, abs));
  if (!scope || hiddenReal(ctx, abs)) throw new VaultError('path is outside the folders you may read');
  return { abs, scope };
}

function relOf(ctx, abs) {
  return path.relative(ctx.root, abs).split(path.sep).join('/');
}

function vaultList(ctx, rel) {
  if (!rel) return ctx.scopes.map((s, i) => `${s.rel}/${i === 0 ? '  (project)' : '  (shared, read-only)'}`).join('\n') || '(no readable folders)';
  const { abs } = resolveInScope(ctx, rel);
  if (!fs.statSync(abs).isDirectory()) throw new VaultError('not a folder');
  const out = [];
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const child = real(path.join(abs, e.name));
    if (!child || !ctx.scopes.some((s) => within(s.abs, child)) || hiddenReal(ctx, child)) continue; // symlink out or into a hidden dir: invisible
    const st = fs.statSync(child);
    if (st.isDirectory()) out.push(`${e.name}/`);
    else if (st.isFile() && e.name.toLowerCase().endsWith('.md')) out.push(`${e.name}  (${st.size} bytes)`);
    if (out.length >= MAX_LIST_ENTRIES) break;
  }
  return out.sort().join('\n') || '(empty)';
}

function vaultRead(ctx, rel) {
  const { abs } = resolveInScope(ctx, rel);
  const st = fs.statSync(abs);
  if (!st.isFile() || !abs.toLowerCase().endsWith('.md')) throw new VaultError('only .md notes can be read');
  const fd = fs.openSync(abs, 'r');
  try {
    const buf = Buffer.alloc(Math.min(st.size, MAX_READ_BYTES));
    fs.readSync(fd, buf, 0, buf.length, 0);
    const text = buf.toString('utf8');
    return st.size > MAX_READ_BYTES ? `${text}\n\n[truncated: ${st.size} bytes, showing first ${MAX_READ_BYTES}]` : text;
  } finally { fs.closeSync(fd); }
}

function* walk(ctx, dir, state) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith('.') || state.n >= MAX_SEARCH_FILES) continue;
    const child = real(path.join(dir, e.name));
    if (!child || !ctx.scopes.some((s) => within(s.abs, child)) || hiddenReal(ctx, child)) continue;
    let st;
    try { st = fs.statSync(child); } catch { continue; }
    if (st.isDirectory()) yield* walk(ctx, child, state);
    else if (st.isFile() && e.name.toLowerCase().endsWith('.md') && st.size <= MAX_SEARCH_FILE_BYTES) { state.n++; yield child; }
  }
}

function vaultSearch(ctx, query, limit) {
  const terms = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) throw new VaultError('query is empty');
  const max = Math.min(Math.max(parseInt(limit, 10) || 10, 1), MAX_RESULTS);
  const state = { n: 0 };
  const hits = [];
  const seen = new Set();
  for (const scope of ctx.scopes) {
    for (const file of walk(ctx, scope.abs, state)) {
      if (seen.has(file)) continue;
      seen.add(file);
      let text;
      try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
      const low = text.toLowerCase();
      const title = path.basename(file, '.md').toLowerCase();
      let score = 0;
      let first = -1;
      let all = true;
      for (const t of terms) {
        const idx = low.indexOf(t);
        if (idx < 0 && !title.includes(t)) { all = false; break; }
        if (first < 0 || (idx >= 0 && idx < first)) first = idx;
        score += low.split(t).length - 1 + (title.includes(t) ? 5 : 0);
      }
      if (!all) continue;
      const at = Math.max(first, 0);
      const snippet = text.slice(Math.max(at - 60, 0), at + SNIPPET).replace(/\s+/g, ' ').trim();
      hits.push({ path: relOf(ctx, file), score, snippet });
    }
  }
  hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return hits.slice(0, max).map((h) => `${h.path}  (score ${h.score})\n  ${h.snippet}`).join('\n\n') || 'no matches';
}


/* ─────────────────────────────── write path ──────────────────────────────────
 * Protocol (99-System/Daily Update Protocol.md): snapshot first and stop if it
 * fails, enrich never delete, uncertain goes to the Inbox, snapshot again at the
 * end. One writer at a time across ALL project agents, enforced by a lock that
 * lives outside the vault. There is no delete and no move anywhere in here. */

const INBOX = '00-Inbox/Inbox.md';
const MAX_WRITE_BYTES = 200 * 1024;
const LOCK_TTL_MS = 15 * 60 * 1000;      // a session idle this long loses the lock
const LOCK_WAIT_MS = 30 * 1000;
const SNAPSHOT_TIMEOUT_MS = 60 * 1000;
const sha = (t) => crypto.createHash('sha256').update(t, 'utf8').digest('hex');
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
const readLock = (lockPath) => {
  try { return JSON.parse(fs.readFileSync(path.join(lockPath, 'info.json'), 'utf8')); } catch { return null; }
};
const writeLock = (lockPath, w) =>
  fs.writeFileSync(path.join(lockPath, 'info.json'), JSON.stringify({ pid: process.pid, agent: w.agent, ts: Date.now() }));

/** Take the global vault lock (atomic mkdir). A lock whose holder is gone or idle
 *  past the TTL is recovered by renaming it aside first, so of several waiters only
 *  one can clear it. ponytail: a waiter that read stale info just before the holder
 *  refreshed it could clear a live lock; the window is the span between two syscalls. */
function acquireLock(w) {
  const deadline = Date.now() + (w.waitMs ?? LOCK_WAIT_MS);
  for (;;) {
    try {
      fs.mkdirSync(w.lockPath);
      writeLock(w.lockPath, w);
      return;
    } catch (e) {
      if (e.code !== 'EEXIST') throw new VaultError('cannot take the vault lock');
    }
    const info = readLock(w.lockPath);
    const stale = !info || !pidAlive(info.pid) || Date.now() - info.ts > LOCK_TTL_MS;
    if (stale) {
      const again = readLock(w.lockPath);
      if (JSON.stringify(again) === JSON.stringify(info)) {
        const aside = `${w.lockPath}.stale-${process.pid}-${Date.now()}`;
        try { fs.renameSync(w.lockPath, aside); fs.rmSync(aside, { recursive: true, force: true }); } catch { /* someone else cleared it */ }
        continue;
      }
    }
    if (Date.now() >= deadline) {
      throw new VaultError(`the vault is being updated by ${info ? info.agent : 'another agent'}; try again shortly`);
    }
    sleep(250);
  }
}

function ownsLock(w) {
  const info = readLock(w.lockPath);
  return !!info && info.pid === process.pid && info.agent === w.agent;
}
function releaseLock(w) {
  if (ownsLock(w)) fs.rmSync(w.lockPath, { recursive: true, force: true });
}

function runSnapshot(ctx, message) {
  const script = path.join(ctx.root, '99-System', 'scripts', 'sb-snapshot.sh');
  if (!fs.existsSync(script)) throw new VaultError('snapshot script is missing; refusing to write');
  try {
    execFileSync('bash', [script, message], { cwd: ctx.root, timeout: SNAPSHOT_TIMEOUT_MS, stdio: 'ignore', env: { PATH: process.env.PATH, HOME: process.env.HOME } });
  } catch {
    throw new VaultError('snapshot failed; refusing to write');
  }
}

function requireWriter(ctx) {
  if (!ctx.write) throw new VaultError('this agent has no write access to the vault');
  return ctx.write;
}
function requireSession(ctx) {
  const w = requireWriter(ctx);
  if (!w.session || !ownsLock(w)) { w.session = null; throw new VaultError('no active write session (it may have expired): call vault_session_begin first'); }
  writeLock(w.lockPath, w); // activity keeps the lock alive
  return w;
}

/** Create the writer's own (missing) project folder, one plain directory at a time.
 *  Called with the lock held and the pre-update snapshot taken. Every existing segment
 *  must be a real directory inside the vault root; nothing outside the project path is made. */
function ensureProjectFolder(ctx) {
  const w = ctx.write;
  if (ctx.scopes.length && ctx.scopes[0].rel === w.projectScope) return;
  let cur = ctx.root;
  for (const seg of w.projectScope.split('/')) {
    cur = path.join(cur, seg);
    let st = null;
    try { st = fs.lstatSync(cur); } catch { /* missing: create below */ }
    if (!st) fs.mkdirSync(cur);
    else if (st.isSymbolicLink() || !st.isDirectory()) throw new VaultError('the project folder path is not a plain folder');
    const r = real(cur);
    if (!r || !within(ctx.root, r) || hiddenReal(ctx, r)) throw new VaultError('the project folder path is outside the vault');
  }
  ctx.scopes.unshift({ rel: w.projectScope, abs: real(cur) });
}

function sessionBegin(ctx, reason) {
  const w = requireWriter(ctx);
  if (w.session && ownsLock(w)) return 'write session already active';
  acquireLock(w);
  try {
    // Protocol step 0: no modification without the safety net.
    runSnapshot(ctx, `SB pre-update (${w.agent})${reason ? `: ${String(reason).slice(0, 80)}` : ''}`);
    ensureProjectFolder(ctx);
  } catch (e) {
    releaseLock(w);
    throw e;
  }
  w.session = { startedAt: Date.now() };
  return 'write session started: vault locked, pre-update snapshot taken';
}

function sessionEnd(ctx) {
  const w = requireWriter(ctx);
  if (!w.session) throw new VaultError('no active write session');
  let note = 'write session ended: post-update snapshot taken, lock released';
  try {
    if (!ownsLock(w)) note = 'write session had expired; lock was already released';
    else runSnapshot(ctx, `SB post-update (${w.agent})`);
  } catch (e) {
    note = `write session ended, but the post-update snapshot FAILED (${e.message}); the pre-update snapshot still holds the previous state`;
  } finally {
    releaseLock(w);
    w.session = null;
  }
  return note;
}

/** Resolve a write target. Project notes: inside the project folder. Inbox: only
 *  the exact Inbox note, only for append. The REAL path of the parent (symlinks
 *  followed) must stay in scope and unhidden, and the file itself must not be a link. */
function resolveWriteTarget(ctx, rel, { append }) {
  const w = requireWriter(ctx);
  const clean = cleanRelative(rel);
  if (!clean || !clean.toLowerCase().endsWith('.md')) throw new VaultError('invalid path: only .md notes can be written');
  const isInbox = clean === INBOX;
  if (isInbox && !append) throw new VaultError('the Inbox is append-only: use vault_append');
  const base = isInbox ? INBOX.split('/')[0] : w.projectScope;
  const baseAbs = real(path.join(ctx.root, base));
  const abs = path.join(ctx.root, clean);
  const parent = real(path.dirname(abs));
  if (!baseAbs || !parent || !within(baseAbs, parent) || hiddenReal(ctx, parent)) throw new VaultError('path is outside the folders you may write');
  let st = null;
  try { st = fs.lstatSync(abs); } catch { /* new file */ }
  if (st && (st.isSymbolicLink() || !st.isFile())) throw new VaultError('path is not a regular note');
  return { abs: path.join(parent, path.basename(abs)), exists: !!st, baseAbs };
}

/**
 * Write a note without trusting directory NAMES to stay put. Node has no openat, so
 * a parent could be swapped for a symlink between our checks and the write. The
 * sequence below makes that harmless instead of racing it:
 *  1. create a temp file with an unguessable name (O_EXCL|O_NOFOLLOW) and keep its fd;
 *  2. before any content exists, prove the temp lives where we think: its real path
 *     is the same inode as our fd, inside the allowed folder, not hidden. A parent
 *     swapped before this point fails here, having created at most an empty file;
 *  3. write the content through the FD, so it lands in that verified inode wherever
 *     the directory name points afterwards;
 *  4. rename temp -> target. If the parent was swapped after step 2, the temp is not
 *     in the new directory (nor can anyone pre-place a file of that random name), so
 *     rename fails with ENOENT instead of completing outside. */
function atomicWrite(abs, text, ctx, baseAbs) {
  if (Buffer.byteLength(text, 'utf8') > MAX_WRITE_BYTES) throw new VaultError(`content too large (max ${MAX_WRITE_BYTES} bytes)`);
  const tmp = path.join(path.dirname(abs), `.tmp-${crypto.randomBytes(12).toString('hex')}`);
  let fd;
  try {
    fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o644);
    const mine = fs.fstatSync(fd);
    const rp = fs.realpathSync(tmp);
    const at = fs.lstatSync(rp);
    if (at.ino !== mine.ino || at.dev !== mine.dev || !within(baseAbs, path.dirname(rp)) || hiddenReal(ctx, path.dirname(rp))) {
      throw new VaultError('the target folder changed during the write; nothing was written');
    }
    fs.writeSync(fd, text);
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    fs.renameSync(tmp, abs);
  } catch (e) {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* already closed */ } }
    try { fs.unlinkSync(tmp); } catch { /* it is not at that name any more */ }
    throw e instanceof VaultError ? e : new VaultError('the target folder changed during the write; nothing was written');
  }
}

function vaultAppend(ctx, rel, text) {
  requireSession(ctx);
  if (typeof text !== 'string' || !text.trim()) throw new VaultError('text is empty');
  const t = resolveWriteTarget(ctx, rel, { append: true });
  const prev = t.exists ? fs.readFileSync(t.abs, 'utf8') : '';
  atomicWrite(t.abs, `${prev}${prev && !prev.endsWith('\n') ? '\n' : ''}${text.endsWith('\n') ? text : `${text}\n`}`, ctx, t.baseAbs);
  return `appended ${Buffer.byteLength(text, 'utf8')} bytes to ${rel}`;
}

/** Create a note, or replace one the caller has read: replacing needs the sha256 of
 *  the content it based the edit on, so a human's concurrent edit in Obsidian is a
 *  conflict instead of being overwritten. The pre-update snapshot covers the rest. */
function vaultWrite(ctx, rel, content, baseHash) {
  requireSession(ctx);
  if (typeof content !== 'string') throw new VaultError('content must be text');
  const t = resolveWriteTarget(ctx, rel, { append: false });
  if (t.exists) {
    const cur = fs.readFileSync(t.abs, 'utf8');
    if (!baseHash) throw new VaultError(`note exists: pass base_hash (sha256 of the content you read: ${sha(cur)})`);
    if (baseHash !== sha(cur)) throw new VaultError(`conflict: the note changed since you read it (current sha256 ${sha(cur)}); read it again`);
  } else if (baseHash) {
    throw new VaultError('base_hash given but the note does not exist');
  }
  atomicWrite(t.abs, content, ctx, t.baseAbs);
  return `${t.exists ? 'replaced' : 'created'} ${rel} (sha256 ${sha(content)})`;
}

const TOOLS = [
  {
    name: 'vault_list',
    description: 'List notes and folders in the project vault. No path lists the readable top-level folders (your project plus shared read-only areas).',
    inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Vault-relative folder, e.g. "01-Projects/Acme"' } } }
  },
  {
    name: 'vault_read',
    description: 'Read one markdown note by vault-relative path (large notes are truncated).',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
  },
  {
    name: 'vault_search',
    description: 'Case-insensitive search over the readable notes; every word must appear. Returns paths with snippets.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } }, required: ['query'] }
  }
];

/** Offered only to the project's writer agent. No delete, no move. */
const WRITE_TOOLS = [
  {
    name: 'vault_session_begin',
    description: 'Start a write session: takes the vault-wide lock (waits up to 30s if another agent is writing) and runs the pre-update snapshot. Refuses to proceed if the snapshot fails. Call before any write; end with vault_session_end.',
    inputSchema: { type: 'object', properties: { reason: { type: 'string' } } }
  },
  {
    name: 'vault_append',
    description: 'Append text to a note in your project folder, or to 00-Inbox/Inbox.md (the place for anything you cannot attribute with certainty). Requires an active session.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, text: { type: 'string' } }, required: ['path', 'text'] }
  },
  {
    name: 'vault_write',
    description: 'Create a note in your project folder, or replace one you have read by passing base_hash (the sha256 of the content you read; a mismatch is a conflict). Never deletes. Requires an active session.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' }, base_hash: { type: 'string' } }, required: ['path', 'content'] }
  },
  {
    name: 'vault_session_end',
    description: 'End the write session: runs the post-update snapshot and releases the lock. Always call it when done.',
    inputSchema: { type: 'object', properties: {} }
  }
];

function callTool(ctx, name, args) {
  const a = args && typeof args === 'object' ? args : {};
  if (!ctx.scopes.length && !ctx.write) throw new VaultError('no vault folders are available for this agent');
  if (name === 'vault_list') return vaultList(ctx, a.path);
  if (name === 'vault_read') return vaultRead(ctx, a.path);
  if (name === 'vault_search') return vaultSearch(ctx, a.query, a.limit);
  if (name === 'vault_session_begin') return sessionBegin(ctx, a.reason);
  if (name === 'vault_session_end') return sessionEnd(ctx);
  if (name === 'vault_append') return vaultAppend(ctx, a.path, a.text);
  if (name === 'vault_write') return vaultWrite(ctx, a.path, a.content, a.base_hash);
  throw new VaultError(`unknown tool ${name}`);
}

function handle(ctx, msg) {
  const { id, method, params } = msg;
  const reply = (result) => ({ jsonrpc: '2.0', id, result });
  const error = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
  if (method === 'initialize') {
    return reply({ protocolVersion: (params && params.protocolVersion) || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'munder-vault', version: '1.0.0' } });
  }
  if (method === 'ping') return reply({});
  if (method === 'tools/list') return reply({ tools: ctx.write ? [...TOOLS, ...WRITE_TOOLS] : TOOLS });
  if (method === 'tools/call') {
    try {
      const text = callTool(ctx, params && params.name, params && params.arguments);
      return reply({ content: [{ type: 'text', text }] });
    } catch (e) {
      const text = e instanceof VaultError ? e.message : 'vault operation failed';
      return reply({ content: [{ type: 'text', text }], isError: true });
    }
  }
  if (id === undefined) return null; // notification
  return error(-32601, `method not found: ${method}`);
}

function serve() {
  const ctx = loadScopes(process.env.VAULT_ROOT, process.env.VAULT_SCOPES, { agent: process.env.VAULT_WRITER_AGENT, lockPath: process.env.VAULT_LOCK_PATH });
  // A dying server must not leave the vault locked (a crash is covered by the TTL).
  process.on('exit', () => { try { const w = ctx.write; if (w && w.session) releaseLock(w); } catch { /* best effort */ } });
  process.stdin.on('end', () => process.exit(0));
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const out = handle(ctx, msg);
      if (out) process.stdout.write(JSON.stringify(out) + '\n');
    }
  });
}

module.exports = { loadScopes, callTool, handle, cleanRelative, TOOLS, WRITE_TOOLS, MAX_READ_BYTES, LOCK_TTL_MS, sha };
if (require.main === module) serve();
