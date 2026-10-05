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
 * Fail-closed: no root, no scopes, or a scope that is not a plain relative path
 * inside the root means nothing is readable. There is no write tool, and no code
 * path here opens a file for writing.
 */

const fs = require('node:fs');
const path = require('node:path');

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
function loadScopes(rootRaw, scopesRaw) {
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
  return { root, scopes };
}

/** Vault-relative path -> { abs, scope }, or throws. The REAL path (symlinks
 *  followed) must sit inside one scope's real directory. */
function resolveInScope(ctx, rel) {
  const clean = cleanRelative(rel);
  if (clean === null || clean === '') throw new VaultError('invalid path');
  const abs = real(path.join(ctx.root, clean));
  if (!abs) throw new VaultError('not found');
  const scope = ctx.scopes.find((s) => within(s.abs, abs));
  if (!scope) throw new VaultError('path is outside the folders you may read');
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
    if (!child || !ctx.scopes.some((s) => within(s.abs, child))) continue; // symlink out: invisible
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
    if (!child || !ctx.scopes.some((s) => within(s.abs, child))) continue;
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

function callTool(ctx, name, args) {
  const a = args && typeof args === 'object' ? args : {};
  if (!ctx.scopes.length) throw new VaultError('no vault folders are available for this agent');
  if (name === 'vault_list') return vaultList(ctx, a.path);
  if (name === 'vault_read') return vaultRead(ctx, a.path);
  if (name === 'vault_search') return vaultSearch(ctx, a.query, a.limit);
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
  if (method === 'tools/list') return reply({ tools: TOOLS });
  if (method === 'tools/call') {
    try {
      const text = callTool(ctx, params && params.name, params && params.arguments);
      return reply({ content: [{ type: 'text', text }] });
    } catch (e) {
      const text = e instanceof VaultError ? e.message : 'vault read failed';
      return reply({ content: [{ type: 'text', text }], isError: true });
    }
  }
  if (id === undefined) return null; // notification
  return error(-32601, `method not found: ${method}`);
}

function serve() {
  const ctx = loadScopes(process.env.VAULT_ROOT, process.env.VAULT_SCOPES);
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

module.exports = { loadScopes, callTool, handle, cleanRelative, TOOLS, MAX_READ_BYTES };
if (require.main === module) serve();
