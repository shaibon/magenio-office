'use strict';

// A hidden summarizer session must run in a directory Claude Code TRUSTS, or it
// never produces a transcript at all. The call used to get its throwaway cwd from
// os.tmpdir() (= /var/folders/... on macOS), which is not a trusted workspace: the
// CLI stops at the "Is this a project you created or one you trust?" dialog — whose
// default answer is "No, exit" — the session exits, no .jsonl is ever written, and
// the caller reports "no assistant response found in transcript". Trust is inherited
// from an ancestor listed in ~/.claude.json, so /tmp cannot be made to work.
//
// The throwaway dir is now created INSIDE the caller's cwd, which is trusted by
// construction because the caller's own long-lived session runs there. The last case
// below spawns a stub binary that behaves like the CLI (writes a transcript into the
// project dir keyed by its own cwd) and proves the whole path end to end.
//
// POSIX-only: projectDir() resolves against os.homedir(), which the fixture
// redirects via $HOME.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const {
  runHiddenClaude, createPrivateCwd, canonicalDir, PRIVATE_CWD_PREFIX
} = loadTs('src/main/hiddenClaude.ts');
const { projectDir } = loadTs('src/main/transcript.ts');

/** A throwaway home, plus a cwd the caller "already works in". */
function withFixture(run) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-trusted-'));
  const prevHome = process.env.HOME;
  const prevConfig = process.env.CLAUDE_CONFIG_DIR;
  process.env.HOME = home;
  delete process.env.CLAUDE_CONFIG_DIR;
  try {
    const cwd = path.join(home, 'work');
    fs.mkdirSync(cwd, { recursive: true });
    return run({ home, cwd });
  } finally {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prevConfig;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// ─── where the throwaway cwd lives ────────────────────────────────────────────

test('the throwaway cwd is created inside the caller\'s directory', () => {
  withFixture(({ cwd }) => {
    const dir = createPrivateCwd(cwd);
    assert.ok(dir, 'expected a directory to be created');
    try {
      assert.equal(path.dirname(dir), canonicalDir(cwd));
      assert.ok(path.basename(dir).startsWith(PRIVATE_CWD_PREFIX), `unexpected name: ${dir}`);
      assert.ok(fs.statSync(dir).isDirectory());
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

test('the throwaway cwd is never os.tmpdir(), even when one is available', () => {
  const home = fs.mkdtempSync(path.join(os.homedir(), '.md-trusted-'));
  const cwd = path.join(home, 'work');
  fs.mkdirSync(cwd, { recursive: true });
  try {
    const dir = createPrivateCwd(cwd);
    assert.ok(dir);
    try {
      // The old behaviour: a sibling of the caller's directory, under the system
      // temp root. It is exactly what the CLI refuses to run in.
      assert.ok(isInside(home, dir), `expected ${dir} under ${home}`);
      assert.ok(!isInside(fs.realpathSync(os.tmpdir()), dir), `must not live under ${os.tmpdir()}`);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('no cwd to host it means no private dir — never a silent fall back to tmpdir', () => {
  withFixture(({ home }) => {
    assert.equal(createPrivateCwd(path.join(home, 'does-not-exist')), null);
  });
});

test('canonicalDir resolves a symlinked cwd, so the project key matches the CLI\'s', () => {
  withFixture(({ home, cwd }) => {
    fs.symlinkSync(cwd, path.join(home, 'link'));
    assert.equal(canonicalDir(path.join(home, 'link')), canonicalDir(cwd));
  });
});

// ─── end-to-end: a stub CLI writes its transcript where the capture looks ─────

/** A stand-in for `claude`: announces itself, waits for the prompt, then writes a
 *  transcript into the project dir keyed by its OWN cwd — the way the real CLI does
 *  — and records where it ran so the test can check it. */
function writeStubCli(file) {
  fs.writeFileSync(file, [
    '#!/usr/bin/env node',
    "'use strict';",
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const cwd = fs.realpathSync(process.cwd());",
    "fs.writeFileSync(process.env.STUB_RAN_AT, cwd);",
    "// Claude Code's project key: every non-alphanumeric character becomes a dash.",
    "const key = cwd.replace(/[^a-zA-Z0-9]/g, '-');",
    "const dir = path.join(process.env.HOME, '.claude', 'projects', key);",
    "process.stdout.write('stub ready\\r\\n');",
    'let done = false;',
    "process.stdin.on('data', () => {",
    '  if (done) return; done = true;',
    '  fs.mkdirSync(dir, { recursive: true });',
    "  fs.writeFileSync(path.join(dir, 'session.jsonl'),",
    "    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'STUB-ANSWER' }] } }) + '\\n');",
    "  process.stdout.write('stub done\\r\\n');",
    '  setTimeout(() => process.exit(0), 50);',
    '});',
    '',
  ].join('\n'));
  fs.chmodSync(file, 0o755);
}

test('a hidden call runs under the caller\'s cwd and its transcript is captured', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-trusted-e2e-'));
  const prevHome = process.env.HOME;
  const prevConfig = process.env.CLAUDE_CONFIG_DIR;
  process.env.HOME = home;
  delete process.env.CLAUDE_CONFIG_DIR;
  try {
    const cwd = path.join(home, 'work');
    fs.mkdirSync(cwd, { recursive: true });
    // The app resolves its cwd before spawning, and this fixture's home sits under
    // a symlinked temp root — compare against the spelling the session itself sees.
    const real = canonicalDir(cwd);
    const stub = path.join(home, 'claude-stub');
    writeStubCli(stub);
    const ranAt = path.join(home, 'ran-at');
    process.env.STUB_RAN_AT = ranAt;

    // A session already living in the caller's directory — the transcript the
    // capture must not mistake for this call's own.
    const foreign = path.join(projectDir(real), 'live.jsonl');
    fs.mkdirSync(path.dirname(foreign), { recursive: true });
    fs.writeFileSync(foreign, JSON.stringify({
      type: 'assistant', message: { content: [{ type: 'text', text: 'FOREIGN-PROSE' }] }
    }) + '\n');

    const result = await runHiddenClaude('summarize please', {
      model: 'stub',
      cwd,
      command: stub,
      timeoutMs: 30_000,
    });

    assert.deepEqual(result, { ok: true, text: 'STUB-ANSWER' });
    const session = fs.readFileSync(ranAt, 'utf8');
    assert.ok(isInside(real, session), `session ran in ${session}, expected a child of ${real}`);
    assert.ok(path.basename(session).startsWith(PRIVATE_CWD_PREFIX));
    // The throwaway directory and its project dir are both gone afterwards.
    assert.equal(fs.existsSync(session), false, 'throwaway cwd should be cleaned up');
    assert.equal(fs.existsSync(projectDir(session)), false, 'its project dir should be cleaned up');
  } finally {
    delete process.env.STUB_RAN_AT;
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prevConfig;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
