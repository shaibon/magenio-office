# Trello intake → Jira — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let god turn Trello cards from a client board into Jira issues automatically, exactly once per card, without ever writing to Trello.

**Architecture:** A Trello source is an optional field on the existing `JiraProjectBinding`, so a board is bound to a Jira project by construction and can never be orphaned. Types and validators live in their own pure module so a standalone Trello registry stays a mechanical extraction later. god reaches Trello through an MCP server scoped to it alone (a new per-agent filter in `hive.ts`), with a preflight that omits an unusable server instead of declaring one that dies at startup, and an explicit installer that clones the server pinned to a tag. Deduplication lives on Jira: each created issue carries the label `trello-<cardShortLink>`, resolved with one JQL per binding.

**Tech Stack:** TypeScript, Electron (main/preload/renderer), React, `node:test` with `test/load-ts.cjs` (on-the-fly TS transpile), i18n via `src/renderer/src/i18n/locales/*.json`.

**Spec:** `docs/superpowers/specs/2026-09-05-trello-intake-design.md`

## Global Constraints

- Branch: `feature/trello-intake` (already created, spec committed on it).
- **Never write to Trello.** No comments, no card moves, no labels. Read only.
- **Never touch live hive state by hand** (`registry.json`, inbox, `tasks.json`) — only through the running app's IPC/UI.
- Shared modules (`src/shared/*`) stay framework-agnostic: no `node:fs`, no `electron`, no React.
- `src/main/mcpProvision.ts` must stay **electron-free** and take every side effect by injection — `hive.ts` imports it, and `node:test` exercises it with fakes.
- The Trello token is never read into a return value, a log line, or an error message. The preflight keeps booleans only.
- The installer clones **pinned to a tag**, never `main`.
- New config fields are optional and additive: an existing `config.json` must load unchanged, with no migration.
- Every new UI string gets a key in all three locales: `en.json`, `zh-CN.json`, `ar.json`.
- Tests are `test/<name>.test.cjs`, CommonJS, `'use strict'`, using `require('./load-ts.cjs')`. Run with `npm run test:focused`.
- `npm run typecheck` (node + web) must pass at the end of every task.

---

### Task 1: Pure Trello intake module

**Files:**
- Create: `src/shared/trelloIntake.ts`
- Test: `test/trello-intake-shared.test.cjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `TrelloIntakeBinding { boardShortLink: string; boardLabel: string; intakeLists: string[]; enabled: boolean }`, `TRELLO_SHORTLINK_RE: RegExp`, `parseTrelloBoardUrl(url: string): string | null`, `jiraLabelForCard(cardShortLink: string): string`, `trelloCardUrl(cardShortLink: string): string`, `validateTrelloIntake(t: TrelloIntakeBinding): string | null` — consumed by Tasks 2, 4, 9.

- [ ] **Step 1: Write the failing test**

Create `test/trello-intake-shared.test.cjs`:

```javascript
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const {
  TRELLO_SHORTLINK_RE,
  parseTrelloBoardUrl,
  jiraLabelForCard,
  trelloCardUrl,
  validateTrelloIntake
} = loadTs('src/shared/trelloIntake.ts');

function binding(over) {
  return {
    boardShortLink: '781LrPy9',
    boardLabel: 'BurdaStyle',
    intakeLists: ['Approvati'],
    enabled: true,
    ...over
  };
}

test('TRELLO_SHORTLINK_RE accepts an 8-char alphanumeric short link', () => {
  assert.ok(TRELLO_SHORTLINK_RE.test('781LrPy9'));
  assert.ok(TRELLO_SHORTLINK_RE.test('kOGceP5w'));
});

test('TRELLO_SHORTLINK_RE rejects wrong lengths and punctuation', () => {
  assert.equal(TRELLO_SHORTLINK_RE.test('781LrPy'), false);
  assert.equal(TRELLO_SHORTLINK_RE.test('781LrPy99'), false);
  assert.equal(TRELLO_SHORTLINK_RE.test('781LrP-9'), false);
});

test('parseTrelloBoardUrl extracts the short link with and without the slug', () => {
  assert.equal(parseTrelloBoardUrl('https://trello.com/b/781LrPy9/burdastyle'), '781LrPy9');
  assert.equal(parseTrelloBoardUrl('https://trello.com/b/781LrPy9'), '781LrPy9');
  assert.equal(parseTrelloBoardUrl('https://trello.com/b/781LrPy9/burdastyle/'), '781LrPy9');
  assert.equal(parseTrelloBoardUrl('https://www.trello.com/b/781LrPy9/x?filter=due'), '781LrPy9');
  assert.equal(parseTrelloBoardUrl('  https://trello.com/b/781LrPy9/x  '), '781LrPy9');
});

test('parseTrelloBoardUrl refuses a card URL, a foreign host and junk', () => {
  assert.equal(parseTrelloBoardUrl('https://trello.com/c/781LrPy9/42-card'), null);
  assert.equal(parseTrelloBoardUrl('https://evil.example.com/b/781LrPy9/x'), null);
  assert.equal(parseTrelloBoardUrl('https://trello.com/b/short/x'), null);
  assert.equal(parseTrelloBoardUrl('not a url'), null);
  assert.equal(parseTrelloBoardUrl(''), null);
});

test('jiraLabelForCard and trelloCardUrl produce the agreed shapes', () => {
  assert.equal(jiraLabelForCard('abcd1234'), 'trello-abcd1234');
  assert.equal(trelloCardUrl('abcd1234'), 'https://trello.com/c/abcd1234');
});

test('validateTrelloIntake accepts a well-formed binding', () => {
  assert.equal(validateTrelloIntake(binding()), null);
});

test('validateTrelloIntake rejects a missing or malformed short link', () => {
  assert.ok(validateTrelloIntake(binding({ boardShortLink: '' })));
  assert.ok(validateTrelloIntake(binding({ boardShortLink: 'nope' })));
});

test('validateTrelloIntake requires at least one intake list', () => {
  assert.ok(validateTrelloIntake(binding({ intakeLists: [] })));
});

test('validateTrelloIntake rejects an empty list name', () => {
  assert.ok(validateTrelloIntake(binding({ intakeLists: ['Approvati', '   '] })));
});

test('validateTrelloIntake rejects duplicate list names case-insensitively', () => {
  const error = validateTrelloIntake(binding({ intakeLists: ['Da fare', 'DA FARE'] }));
  assert.ok(typeof error === 'string' && error.length > 0);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/trello-intake-shared.test.cjs`
Expected: FAIL — `src/shared/trelloIntake.ts` does not exist, so `loadTs` throws.

- [ ] **Step 3: Write the module**

Create `src/shared/trelloIntake.ts`:

```ts
/**
 * Trello intake — canonical types + pure validators.
 *
 * Framework-agnostic (no node:fs, no electron), exactly like
 * shared/jiraProjects.ts: usable from main, preload and renderer alike.
 *
 * Lives in its own module even though the data hangs off JiraProjectBinding:
 * if a standalone Trello registry is ever needed, this file moves as-is.
 * See docs/superpowers/specs/2026-09-05-trello-intake-design.md.
 */

export interface TrelloIntakeBinding {
  /** shortLink of the board, taken from its URL (e.g. "781LrPy9"). Immutable,
   *  and accepted by the Trello API anywhere a board id is accepted. */
  boardShortLink: string;
  /** Board name — DISPLAY ONLY, never identity (Trello boards get renamed). */
  boardLabel: string;
  /** EXACT list names, resolved by god against the live board each cycle. Not
   *  ids: main cannot reach Trello, so an id would have to be fetched by hand
   *  outside the app. */
  intakeLists: string[];
  /** Turns intake off without touching the project's own Jira poll. */
  enabled: boolean;
}

/** Board short link: 8 alphanumeric characters, as it appears in /b/<short>/. */
export const TRELLO_SHORTLINK_RE = /^[A-Za-z0-9]{8}$/;

/** Extracts the short link from a BOARD url (https://trello.com/b/<short>/<slug>).
 *  Returns null for a foreign host, for a CARD url (/c/<short>) and for anything
 *  else. Tolerates a missing slug, a trailing slash and a query string. Never throws. */
export function parseTrelloBoardUrl(url: string): string | null {
  if (typeof url !== 'string' || !url.trim()) return null;
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  if (parsed.hostname !== 'trello.com' && parsed.hostname !== 'www.trello.com') return null;
  const parts = parsed.pathname.split('/').filter(Boolean);
  // parts[0] must be 'b' — a '/c/' path is a card, and binding a card as if it
  // were a board would poll one card forever.
  if (parts.length < 2 || parts[0] !== 'b') return null;
  return TRELLO_SHORTLINK_RE.test(parts[1]) ? parts[1] : null;
}

/** The Jira label marking an issue as born from a Trello card. Uses the CARD's
 *  shortLink (globally unique and immutable), never its long id nor its title.
 *  THIS IS THE DEDUPLICATION KEY of the intake poll: changing this function
 *  means re-creating the entire backlog. */
export function jiraLabelForCard(cardShortLink: string): string {
  return `trello-${cardShortLink}`;
}

/** Public URL of a card, for the Jira remote issue link. */
export function trelloCardUrl(cardShortLink: string): string {
  return `https://trello.com/c/${cardShortLink}`;
}

/** Returns an error message, or null when the intake binding is valid. */
export function validateTrelloIntake(t: TrelloIntakeBinding): string | null {
  const short = (t.boardShortLink ?? '').trim();
  if (!short) return 'A Trello board URL is required.';
  if (!TRELLO_SHORTLINK_RE.test(short)) {
    return 'The Trello board id must be the 8-character short link from the board URL (e.g. "781LrPy9").';
  }
  const raw = t.intakeLists ?? [];
  const trimmed = raw.map((n) => (n ?? '').trim());
  if (trimmed.some((n) => !n)) return 'Intake list names cannot be empty.';
  if (trimmed.length === 0) return 'At least one intake list is required.';
  const seen = new Set<string>();
  for (const name of trimmed) {
    const key = name.toLowerCase();
    if (seen.has(key)) return `Duplicate intake list "${name}".`;
    seen.add(key);
  }
  return null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/trello-intake-shared.test.cjs`
Expected: PASS, 10 tests.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/shared/trelloIntake.ts test/trello-intake-shared.test.cjs
git commit -m "feat(shared): Trello intake types, URL parser and validators"
```

---

### Task 2: Hang the Trello source off the Jira binding

**Files:**
- Modify: `src/shared/jiraProjects.ts` (add the `trello?` field to `JiraProjectBinding`)
- Modify: `src/main/jiraProjects.ts` (call `validateTrelloIntake` inside `validateJiraProjectBinding`)
- Test: `test/trello-intake-validate.test.cjs`
- Test: `test/trello-bindings-broker.test.cjs`

**Interfaces:**
- Consumes: `TrelloIntakeBinding`, `validateTrelloIntake` from Task 1.
- Produces: `JiraProjectBinding.trello?: TrelloIntakeBinding` — consumed by Tasks 4 and 9, and read by god over `GET /jira-bindings`.

- [ ] **Step 1: Write the failing validation test**

Create `test/trello-intake-validate.test.cjs`:

```javascript
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const loadTs = require('./load-ts.cjs');

// jiraProjects.ts imports ./config at load time, which resolves its file
// through electron's app.getPath. The mock MUST be installed before the first
// load (loadTs caches by filename for the life of this file).
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'md-trello-validate-'));
const electronPath = require.resolve('electron');
require.cache[electronPath] = {
  id: electronPath, filename: electronPath, loaded: true,
  exports: { app: { getPath: () => userData } }
};

const { validateJiraProjectBinding } = loadTs('src/main/jiraProjects.ts');
const { isRepo, getBranches } = loadTs('src/main/git.ts');

test.after(() => fs.rmSync(userData, { recursive: true, force: true }));

function initRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-trello-repo-'));
  spawnSync('git', ['init', '-q'], { cwd: dir });
  spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'a.txt'), 'x');
  spawnSync('git', ['add', 'a.txt'], { cwd: dir });
  spawnSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
  spawnSync('git', ['branch', 'develop'], { cwd: dir });
  return dir;
}

const deps = { isRepo, getBranches, agentExists: () => true };

function bindingWith(trello, repo) {
  return { key: 'BURD', repo, baseBranch: 'develop', enabled: true, ...(trello ? { trello } : {}) };
}

test('a binding with no trello source still validates exactly as before', async () => {
  const repo = initRepo();
  const result = await validateJiraProjectBinding(bindingWith(null, repo), [], deps);
  assert.deepEqual(result, { ok: true });
});

test('a well-formed trello source validates', async () => {
  const repo = initRepo();
  const trello = { boardShortLink: '781LrPy9', boardLabel: 'BurdaStyle', intakeLists: ['Approvati'], enabled: true };
  const result = await validateJiraProjectBinding(bindingWith(trello, repo), [], deps);
  assert.deepEqual(result, { ok: true });
});

test('a malformed trello short link is rejected with a message', async () => {
  const repo = initRepo();
  const trello = { boardShortLink: 'nope', boardLabel: 'X', intakeLists: ['Approvati'], enabled: true };
  const result = await validateJiraProjectBinding(bindingWith(trello, repo), [], deps);
  assert.equal(result.ok, false);
  assert.ok(/short link/i.test(result.error));
});

test('a trello source with no intake list is rejected', async () => {
  const repo = initRepo();
  const trello = { boardShortLink: '781LrPy9', boardLabel: 'X', intakeLists: [], enabled: true };
  const result = await validateJiraProjectBinding(bindingWith(trello, repo), [], deps);
  assert.equal(result.ok, false);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/trello-intake-validate.test.cjs`
Expected: FAIL — the malformed and empty-list cases return `{ ok: true }` because nothing validates the field yet.

- [ ] **Step 3: Add the field**

In `src/shared/jiraProjects.ts`, add this import right below the file's doc comment:

```ts
import type { TrelloIntakeBinding } from './trelloIntake';
```

and add this field to `JiraProjectBinding`, after `agents?`:

```ts
  /** Trello source upstream of this project: the cards in these lists become
   *  issues of `key`. Absent = no Trello intake. Deliberately a field on the
   *  Jira binding and not a registry of its own — that makes a Trello source
   *  pointing at a deleted Jira project unrepresentable. */
  trello?: TrelloIntakeBinding;
```

- [ ] **Step 4: Validate the field**

In `src/main/jiraProjects.ts`, extend the import from `../shared/jiraProjects` with nothing, and add a new import:

```ts
import { validateTrelloIntake } from '../shared/trelloIntake';
```

Then, inside `validateJiraProjectBinding`, immediately after the `for (const agentId of binding.agents ?? [])` loop and before the `if (deps.testJiraKey)` block, insert:

```ts
  // Format only. Main has no route to Trello (the MCP lives agent-side), so a
  // board or a list that does not exist surfaces at the first poll, named, not
  // at save time.
  if (binding.trello) {
    const trelloError = validateTrelloIntake(binding.trello);
    if (trelloError) return { ok: false, error: trelloError };
  }
```

- [ ] **Step 5: Run the validation test to verify it passes**

Run: `node --test test/trello-intake-validate.test.cjs`
Expected: PASS, 4 tests.

- [ ] **Step 6: Write the broker regression test**

Create `test/trello-bindings-broker.test.cjs`:

```javascript
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
```

- [ ] **Step 7: Run the broker test**

Run: `node --test test/trello-bindings-broker.test.cjs`
Expected: PASS, 2 tests. No production change is needed — `getJiraBindings` serializes the whole binding. If this fails, the field was added in the wrong place.

- [ ] **Step 8: Typecheck and run the full focused suite**

Run: `npm run typecheck && npm run test:focused`
Expected: no type errors, all tests pass.

- [ ] **Step 9: Commit**

```bash
git add src/shared/jiraProjects.ts src/main/jiraProjects.ts test/trello-intake-validate.test.cjs test/trello-bindings-broker.test.cjs
git commit -m "feat(jira): optional Trello intake source on a project binding"
```

---

### Task 3: Catalog entry for a user-configured MCP server

**Files:**
- Modify: `src/shared/mcpCatalog.ts`
- Test: `test/trello-mcp-catalog.test.cjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `McpCatalogEntry.userConfigured?: boolean`, the `trello` catalog entry, `TRELLO_MCP_REPO_URL: string`, `TRELLO_MCP_TAG: string` — consumed by Tasks 5, 6, 8.

- [ ] **Step 1: Write the failing test**

Create `test/trello-mcp-catalog.test.cjs`:

```javascript
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const {
  MCP_CATALOG,
  mcpCatalogEntry,
  isSafeReadonlyMcp,
  defaultMcpDefaults,
  TRELLO_MCP_REPO_URL,
  TRELLO_MCP_TAG
} = loadTs('src/shared/mcpCatalog.ts');

test('the trello entry exists, is user-configured and ships off', () => {
  const entry = mcpCatalogEntry('trello');
  assert.ok(entry, 'no trello entry in MCP_CATALOG');
  assert.equal(entry.userConfigured, true);
  assert.equal(entry.tier, 'write');
  assert.equal(entry.defaultEnabled, false);
  assert.equal(entry.spec.command, '', 'the command is supplied by the user, not the catalog');
});

test('trello is not a safe-readonly server', () => {
  assert.equal(isSafeReadonlyMcp('trello'), false);
});

test('defaultMcpDefaults seeds trello as disabled', () => {
  assert.deepEqual(defaultMcpDefaults().trello, { enabled: false });
});

test('the installer source is pinned to a tag, never a branch', () => {
  assert.equal(TRELLO_MCP_REPO_URL, 'https://github.com/delorenj/mcp-server-trello.git');
  assert.match(TRELLO_MCP_TAG, /^v\d+\.\d+\.\d+$/);
});

test('every other catalog entry keeps a non-empty command', () => {
  for (const entry of MCP_CATALOG) {
    if (entry.userConfigured) continue;
    assert.ok(entry.spec.command.length > 0, `${entry.id} lost its command`);
  }
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/trello-mcp-catalog.test.cjs`
Expected: FAIL — `mcpCatalogEntry('trello')` is undefined and the two constants are not exported.

- [ ] **Step 3: Extend the catalog**

In `src/shared/mcpCatalog.ts`, add this field to `McpCatalogEntry`, right after `tier`:

```ts
  /** The launch command is NOT distributable (a local server, an absolute path,
   *  the user's own build): `spec` is a placeholder and the real values come
   *  from `config.mcpDefaults[id].command/args`. */
  userConfigured?: boolean;
```

Add these constants just above `MCP_CATALOG`:

```ts
/** Upstream repo of the Trello MCP server the installer clones, and the TAG it
 *  is pinned to. Pinned deliberately: the app builds this third-party code and
 *  runs it inside its own agents, so a moving `main` would mean two installs
 *  are not the same software. Raising this tag is a reviewable code change. */
export const TRELLO_MCP_REPO_URL = 'https://github.com/delorenj/mcp-server-trello.git';
export const TRELLO_MCP_TAG = 'v1.8.0';
```

Append this entry to `MCP_CATALOG`, in the write/secret section:

```ts
  {
    id: 'trello',
    label: 'Trello (read-only intake)',
    description: 'Reads Trello boards, lists and cards for the Trello→Jira intake poll. You supply the launch command; the server holds its own credentials in its .env.',
    // Placeholder: userConfigured entries take command/args from the consent map.
    spec: { command: '', args: [] },
    tier: 'write',
    defaultEnabled: false,
    userConfigured: true
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/trello-mcp-catalog.test.cjs`
Expected: PASS, 5 tests.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/shared/mcpCatalog.ts test/trello-mcp-catalog.test.cjs
git commit -m "feat(mcp): user-configured catalog entries + pinned Trello server entry"
```

---

### Task 4: Config shape, intake mission, seeding

**Files:**
- Modify: `src/main/config.ts` (mcpDefaults shape, `trelloIntakeSeeded`, `TRELLO_INTAKE_MISSION`)
- Modify: `src/renderer/src/store/config.ts:105` (mcpDefaults mirror)
- Modify: `src/preload/index.ts:288` (mcpDefaults mirror)
- Modify: `src/main/hive.ts:50` (`McpDefaultsMap` local shape)
- Modify: `src/main/index.ts` (seed the mission after the `jiraPollSeeded` block, ~line 946)
- Modify: `resources/skills/capabilities/SKILL.md`
- Test: `test/trello-intake-config.test.cjs`

**Interfaces:**
- Consumes: nothing from earlier tasks at runtime.
- Produces: `McpConsentEntry = { enabled: boolean; agents?: string[]; command?: string; args?: string[] }` as the value type of `HarnessConfig.mcpDefaults`, `HarnessConfig.trelloIntakeSeeded?: boolean`, `TRELLO_INTAKE_MISSION: ScheduledMission` — consumed by Tasks 5, 6, 7, 8.

- [ ] **Step 1: Write the failing test**

Create `test/trello-intake-config.test.cjs`:

```javascript
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'md-trello-config-'));
const electronPath = require.resolve('electron');
require.cache[electronPath] = {
  id: electronPath, filename: electronPath, loaded: true,
  exports: { app: { getPath: () => userData } }
};

const { TRELLO_INTAKE_MISSION, readConfig } = loadTs('src/main/config.ts');

test.after(() => fs.rmSync(userData, { recursive: true, force: true }));

test('the intake mission targets god, ships disabled, and polls every 15 minutes', () => {
  assert.equal(TRELLO_INTAKE_MISSION.id, 'trello-intake');
  assert.equal(TRELLO_INTAKE_MISSION.to, 'god');
  assert.equal(TRELLO_INTAKE_MISSION.enabled, false);
  assert.equal(TRELLO_INTAKE_MISSION.intervalMs, 900000);
});

test('the mission body carries the rules that keep it from doing damage', () => {
  const body = TRELLO_INTAKE_MISSION.body;
  assert.match(body, /\/jira-bindings/, 'must read bindings from the broker');
  assert.match(body, /trello-<shortLink>/, 'must state the dedup label convention');
  assert.match(body, /abort/i, 'must state the abort-on-failed-JQL rule');
  assert.match(body, /\b10\b/, 'must state the per-cycle cap');
  assert.match(body, /never write to trello/i, 'must state the read-only rule');
  assert.match(body, /unassigned/i, 'must state that the issue is created unassigned');
});

test('a fresh config loads with no trello intake seeded flag set', () => {
  const cfg = readConfig();
  assert.equal(cfg.trelloIntakeSeeded, undefined);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/trello-intake-config.test.cjs`
Expected: FAIL — `TRELLO_INTAKE_MISSION` is undefined.

- [ ] **Step 3: Add the mission**

In `src/main/config.ts`, immediately after the `JIRA_POLL_MISSION` declaration (ends ~line 152), add:

```ts
/** Trello → Jira intake. Reads the cards of each binding's intake lists from
 *  Trello (through the `trello` MCP server, which only god receives) and creates
 *  the matching Jira issue for the ones that do not have one yet. NEVER writes
 *  to Trello: the link lives on the Jira side, as a label plus a remote link.
 *  Shipped DISABLED — it creates issues on a real tracker. */
export const TRELLO_INTAKE_MISSION: ScheduledMission = {
  id: 'trello-intake',
  label: 'Trello intake → Jira',
  intervalMs: 900_000,
  to: 'god',
  body:
    'Trello intake. Fetch the active project bindings from the loopback broker ' +
    '(GET /jira-bindings via MD_BROKER_URL, with your MD_BROKER_TOKEN capability ' +
    'header). Work ONLY on bindings whose `trello` field is present with ' +
    'trello.enabled === true; ignore every other binding. For each such binding: ' +
    '(1) using the trello MCP server, read the cards of every list named in ' +
    'trello.intakeLists on the board trello.boardShortLink — match list names ' +
    'EXACTLY; a name that is not on the board is reported as an error naming that ' +
    'list, and you carry on with the others. ' +
    '(2) For every card read, form the label trello-<shortLink> from the CARD\'s ' +
    'shortLink (never its long id, never its title). ' +
    '(3) Run ONE JQL for the binding: project = <binding.key> AND labels in ' +
    '("trello-…", …) listing every label from step 2. This tells you which cards ' +
    'already have an issue. ' +
    '(4) IF THAT QUERY FAILS OR ITS RESULT IS AMBIGUOUS, ABORT THIS BINDING AND ' +
    'CREATE NOTHING. A failed query is not "no duplicates" — treating it as one ' +
    'recreates the whole backlog. This rule outranks everything else here. ' +
    '(5) For each card whose label is absent from the result, create an issue in ' +
    'project <binding.key> with: summary = the card title; description = the card ' +
    'description, its checklist items, and the card URL; the label ' +
    'trello-<shortLink>; and a remote issue link to the card URL whose globalId is ' +
    'that same label. ' +
    '(6) Create the issue UNASSIGNED and do not transition it. jira-poll only ' +
    'claims assigned issues, so a human assigning it in Jira is the deliberate ' +
    'gate between a client board and the fleet. Do not assign it yourself. ' +
    '(7) Create at most 10 new issues per binding per cycle. If more cards ' +
    'qualify, create the first 10 and report the remainder — a mis-pointed list ' +
    'must not turn into 200 issues. ' +
    '(8) Transcribe, do not interpret: the client\'s words reach Jira as written. ' +
    'The issue is the starting point a human refines, not your rewrite of it. ' +
    '(9) NEVER WRITE TO TRELLO — no comments, no card moves, no labels, no ' +
    'archiving. The trello MCP server exposes write tools; you do not use them. ' +
    'Report per binding: cards read, already tracked, created (with their keys), ' +
    'and any list you could not find.',
  enabled: false
};
```

- [ ] **Step 4: Extend the config shapes**

In `src/main/config.ts`, replace the `mcpDefaults` field (~line 295) with:

```ts
  /** Per-server consent state for the default MCP bundle, keyed by catalog id.
   *  Seeded from MCP_CATALOG (safe-readonly ON, write/secret OFF); the user flips
   *  these in Settings. A server is wired into an agent only when enabled here.
   *  `agents` narrows a server to specific agent ids (absent/empty = every agent,
   *  today's behaviour). `command`/`args` supply the launch command for catalog
   *  entries flagged `userConfigured` — and are IGNORED for every other entry. */
  mcpDefaults?: {
    [id: string]: { enabled: boolean; agents?: string[]; command?: string; args?: string[] };
  };
```

Add, right after `jiraPollSeeded?: boolean;` (~line 312):

```ts
  /** Mirrors jiraPollSeeded for TRELLO_INTAKE_MISSION. */
  trelloIntakeSeeded?: boolean;
```

Apply the identical `mcpDefaults` shape to the two mirrors: `src/renderer/src/store/config.ts:105` and `src/preload/index.ts:288` (the one-line form is fine there — match the surrounding style of each file).

In `src/main/hive.ts`, replace the local `McpDefaultsMap` (line 50) with:

```ts
type McpDefaultsMap =
  | { [id: string]: { enabled: boolean; agents?: string[]; command?: string; args?: string[] } }
  | undefined;
```

- [ ] **Step 5: Seed the mission**

In `src/main/index.ts`, immediately after the `if (!cfg3.jiraPollSeeded) { … }` block (~line 946), add:

```ts
  // Seed the Trello intake once. Shipped DISABLED like the Jira poll — it
  // creates issues on a real tracker, so the user opts in from the Schedules
  // panel once a board is bound to a project.
  const cfg4 = readConfig();
  if (!cfg4.trelloIntakeSeeded) {
    const missions = cfg4.missions ?? [];
    const has = missions.some((m) => m.id === TRELLO_INTAKE_MISSION.id);
    writeConfig({
      missions: has ? missions : [...missions, { ...TRELLO_INTAKE_MISSION, lastFiredAt: Date.now() }],
      trelloIntakeSeeded: true
    });
  }
```

and add `TRELLO_INTAKE_MISSION` to the existing import from `./config` on line 18.

- [ ] **Step 6: Document the field for agents**

In `resources/skills/capabilities/SKILL.md`, in the paragraph that documents `GET /jira-bindings`, append:

```markdown
  A binding may also carry a `trello` block (`{ boardShortLink, boardLabel,
  intakeLists, enabled }`) naming the Trello board and lists that feed that Jira
  project. It is read-only context: nothing in the harness ever writes to Trello.
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `node --test test/trello-intake-config.test.cjs`
Expected: PASS, 3 tests.

- [ ] **Step 8: Typecheck and run the full focused suite**

Run: `npm run typecheck && npm run test:focused`
Expected: no type errors; all tests pass. The `mcpDefaults` widening is additive, so existing MCP tests must stay green.

- [ ] **Step 9: Commit**

```bash
git add src/main/config.ts src/renderer/src/store/config.ts src/preload/index.ts src/main/hive.ts src/main/index.ts resources/skills/capabilities/SKILL.md test/trello-intake-config.test.cjs
git commit -m "feat(config): Trello intake mission, per-agent MCP consent shape"
```

---

### Task 5: MCP preflight and installer

**Files:**
- Create: `src/main/mcpProvision.ts`
- Test: `test/mcp-provision.test.cjs`

**Interfaces:**
- Consumes: `TRELLO_MCP_REPO_URL`, `TRELLO_MCP_TAG` from Task 3.
- Produces: `McpPresenceReason`, `McpPresence { ok, reason?, detail? }`, `McpConsent { enabled, agents?, command?, args? }`, `PresenceDeps`, `InstallDeps`, `envAssignsNonEmpty(text, key): boolean`, `checkMcpPresence(entryId, consent, deps): McpPresence`, `nodePresenceDeps(): PresenceDeps`, `installTrelloMcp(destDir, deps): Promise<{ ok: true; command: string; args: string[] } | { ok: false; error: string }>`, `nodeInstallDeps(): InstallDeps` — consumed by Tasks 6 and 7.

- [ ] **Step 1: Write the failing test**

Create `test/mcp-provision.test.cjs`:

```javascript
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { envAssignsNonEmpty, checkMcpPresence, installTrelloMcp } = loadTs('src/main/mcpProvision.ts');
const { TRELLO_MCP_TAG } = loadTs('src/shared/mcpCatalog.ts');

const GOOD_ENV = 'TRELLO_API_KEY=abc123\nTRELLO_TOKEN="s3cr3t-value"\n';

function presenceDeps(over) {
  return {
    fileExists: () => true,
    isExecutable: () => true,
    readText: () => GOOD_ENV,
    ...over
  };
}

const consent = { enabled: true, command: '/bin/bun', args: ['/pkg/build/index.js'] };

test('a fully configured, present, credentialed server passes', () => {
  assert.deepEqual(checkMcpPresence('trello', consent, presenceDeps()), { ok: true });
});

test('a consent with no command reports not_configured', () => {
  const result = checkMcpPresence('trello', { enabled: true }, presenceDeps());
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'not_configured');
});

test('a missing or non-executable binary reports command_missing', () => {
  const missing = checkMcpPresence('trello', consent, presenceDeps({ fileExists: (p) => p !== '/bin/bun' }));
  assert.equal(missing.reason, 'command_missing');
  const notExec = checkMcpPresence('trello', consent, presenceDeps({ isExecutable: () => false }));
  assert.equal(notExec.reason, 'command_missing');
});

test('a missing entry file reports entry_missing', () => {
  const result = checkMcpPresence('trello', consent, presenceDeps({ fileExists: (p) => p !== '/pkg/build/index.js' }));
  assert.equal(result.reason, 'entry_missing');
});

test('a .env without TRELLO_TOKEN reports credentials_missing and names the key', () => {
  const result = checkMcpPresence('trello', consent, presenceDeps({ readText: () => 'TRELLO_API_KEY=abc123\n' }));
  assert.equal(result.reason, 'credentials_missing');
  assert.match(result.detail, /TRELLO_TOKEN/);
});

test('an absent .env reports credentials_missing', () => {
  const deps = presenceDeps({ fileExists: (p) => !p.endsWith('.env'), readText: () => null });
  assert.equal(checkMcpPresence('trello', consent, deps).reason, 'credentials_missing');
});

test('the preflight never discloses a credential value', () => {
  const result = checkMcpPresence('trello', consent, presenceDeps({ readText: () => 'TRELLO_API_KEY=abc123\n' }));
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes('abc123'), false, 'the preflight leaked a secret value');
});

test('envAssignsNonEmpty ignores comments, blanks and empty assignments', () => {
  assert.equal(envAssignsNonEmpty('# TRELLO_TOKEN=x\n', 'TRELLO_TOKEN'), false);
  assert.equal(envAssignsNonEmpty('TRELLO_TOKEN=\n', 'TRELLO_TOKEN'), false);
  assert.equal(envAssignsNonEmpty('TRELLO_TOKEN=""\n', 'TRELLO_TOKEN'), false);
  assert.equal(envAssignsNonEmpty('export TRELLO_TOKEN=abc\n', 'TRELLO_TOKEN'), true);
});

test('a non-trello entry is not credential-checked', () => {
  const result = checkMcpPresence('something-else', consent, presenceDeps({ readText: () => '' }));
  assert.deepEqual(result, { ok: true });
});

function installDeps(over) {
  const calls = [];
  return {
    calls,
    deps: {
      dirExistsNonEmpty: () => false,
      which: () => '/bin/bun',
      run: (cmd, args, cwd) => { calls.push({ cmd, args, cwd }); return { ok: true }; },
      fileExists: () => true,
      copyFile: (from, to) => { calls.push({ cmd: 'copy', args: [from, to] }); },
      ...over
    }
  };
}

test('install refuses a destination that already has content', async () => {
  const { deps, calls } = installDeps({ dirExistsNonEmpty: () => true });
  const result = await installTrelloMcp('/dest', deps);
  assert.equal(result.ok, false);
  assert.match(result.error, /not empty/i);
  assert.equal(calls.length, 0, 'it must not touch a non-empty destination');
});

test('install fails before cloning when bun is missing', async () => {
  const { deps, calls } = installDeps({ which: () => null });
  const result = await installTrelloMcp('/dest', deps);
  assert.equal(result.ok, false);
  assert.match(result.error, /bun/i);
  assert.equal(calls.length, 0, 'it must not clone before checking the toolchain');
});

test('install clones the pinned tag, never a branch', async () => {
  const { deps, calls } = installDeps();
  const result = await installTrelloMcp('/dest', deps);
  assert.equal(result.ok, true);
  const clone = calls.find((c) => c.cmd === 'git');
  assert.ok(clone, 'no git clone was run');
  assert.ok(clone.args.includes('--branch'));
  assert.ok(clone.args.includes(TRELLO_MCP_TAG));
  assert.equal(clone.args.includes('main'), false);
});

test('install returns the command and args the UI pre-fills', async () => {
  const { deps } = installDeps();
  const result = await installTrelloMcp('/dest', deps);
  assert.equal(result.command, '/bin/bun');
  assert.deepEqual(result.args, ['/dest/build/index.js']);
});

test('install reports the failing step instead of leaving a half-built dir silently', async () => {
  const { deps } = installDeps({ run: (cmd) => (cmd === 'git' ? { ok: true } : { ok: false, stderr: 'build blew up' }) });
  const result = await installTrelloMcp('/dest', deps);
  assert.equal(result.ok, false);
  assert.match(result.error, /build blew up/);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/mcp-provision.test.cjs`
Expected: FAIL — `src/main/mcpProvision.ts` does not exist.

- [ ] **Step 3: Write the module**

Create `src/main/mcpProvision.ts`:

```ts
/**
 * MCP server preflight + provisioning (main process).
 *
 * ELECTRON-FREE by design, and every side effect is injected: hive.ts imports
 * this to decide whether to declare a server at spawn time, and node:test
 * exercises it with fakes. `nodePresenceDeps()`/`nodeInstallDeps()` are the
 * production wirings.
 *
 * Why it exists: a declared-but-broken MCP server is the worst failure shape.
 * The client keeps retrying, the agent silently has no tools, and the intake
 * mission reports "no cards" when the truth is "Trello was never reachable".
 *
 * SECURITY: the credentials check opens the server's own .env. It keeps
 * BOOLEANS ONLY — no value is ever returned, logged, or put in an error.
 *
 * Contract: docs/superpowers/specs/2026-09-05-trello-intake-design.md §C.
 */
import { existsSync, accessSync, constants, readFileSync, readdirSync, copyFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { TRELLO_MCP_REPO_URL, TRELLO_MCP_TAG } from '../shared/mcpCatalog';

export type McpPresenceReason =
  | 'not_configured'       // command/args not filled in from Settings
  | 'command_missing'      // the binary does not exist or is not executable
  | 'entry_missing'        // the entry file (the build output) does not exist
  | 'credentials_missing'; // the package's .env lacks a required key

export interface McpPresence {
  ok: boolean;
  reason?: McpPresenceReason;
  /** Human-readable detail. NAMES a missing key; never carries its value. */
  detail?: string;
}

export interface McpConsent {
  enabled: boolean;
  agents?: string[];
  command?: string;
  args?: string[];
}

export interface PresenceDeps {
  fileExists: (p: string) => boolean;
  isExecutable: (p: string) => boolean;
  /** File contents, or null when unreadable/absent. */
  readText: (p: string) => string | null;
}

/** Keys the Trello server refuses to start without (its src/index.ts throws). */
const TRELLO_REQUIRED_ENV = ['TRELLO_API_KEY', 'TRELLO_TOKEN'] as const;

/** True iff `text` assigns a NON-EMPTY value to `key`. Returns a boolean and
 *  nothing else: the value is never returned, logged, or retained. */
export function envAssignsNonEmpty(text: string, key: string): boolean {
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const name = line.slice(0, eq).trim().replace(/^export\s+/, '');
    if (name !== key) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (value.length > 0) return true;
  }
  return false;
}

/**
 * Can this user-configured MCP server actually run right now?
 *
 * Checks, in order: command + args filled in → binary present and executable →
 * entry file present → (trello only) the package .env carries the required keys.
 */
export function checkMcpPresence(
  entryId: string,
  consent: McpConsent | undefined,
  deps: PresenceDeps
): McpPresence {
  const command = consent?.command?.trim();
  const entry = consent?.args?.[0]?.trim();
  if (!command || !entry) {
    return { ok: false, reason: 'not_configured', detail: 'Set the launch command and arguments in Settings.' };
  }
  if (!deps.fileExists(command) || !deps.isExecutable(command)) {
    return { ok: false, reason: 'command_missing', detail: `Not an executable file: ${command}` };
  }
  if (!deps.fileExists(entry)) {
    return { ok: false, reason: 'entry_missing', detail: `Entry file not found: ${entry}. The server may need to be built.` };
  }
  if (entryId === 'trello') {
    // The server loads `join(__dirname, '../.env')` — mirror that exactly, so
    // we look where it actually looks.
    const envPath = join(dirname(entry), '..', '.env');
    const text = deps.fileExists(envPath) ? deps.readText(envPath) : null;
    if (text === null) {
      return { ok: false, reason: 'credentials_missing', detail: `No .env at ${envPath}. It must set ${TRELLO_REQUIRED_ENV.join(' and ')}.` };
    }
    const missing = TRELLO_REQUIRED_ENV.filter((key) => !envAssignsNonEmpty(text, key));
    if (missing.length) {
      return { ok: false, reason: 'credentials_missing', detail: `${envPath} is missing a value for ${missing.join(' and ')}.` };
    }
  }
  return { ok: true };
}

/** Production wiring of the preflight checks. */
export function nodePresenceDeps(): PresenceDeps {
  return {
    fileExists: (p) => {
      try { return existsSync(p); } catch { return false; }
    },
    isExecutable: (p) => {
      try { accessSync(p, constants.X_OK); return true; } catch { return false; }
    },
    readText: (p) => {
      try { return readFileSync(p, 'utf8'); } catch { return null; }
    }
  };
}

export interface InstallDeps {
  dirExistsNonEmpty: (p: string) => boolean;
  /** Absolute path of a binary on PATH, or null. */
  which: (bin: string) => string | null;
  run: (cmd: string, args: string[], cwd?: string) => { ok: boolean; stderr?: string };
  fileExists: (p: string) => boolean;
  copyFile: (from: string, to: string) => void;
}

/**
 * Clone + build the Trello MCP server into `destDir`.
 *
 * An EXPLICIT user action only — never called at spawn, never automatic. The
 * app is cloning third-party code that will then run inside its own agents, so
 * the clone is pinned to a tag and the toolchain is checked before anything is
 * fetched.
 *
 * Credentials are NOT written: the .env lands with empty values and the user
 * fills it in. The preflight then reports `credentials_missing` until they do,
 * which is the true state.
 */
export async function installTrelloMcp(
  destDir: string,
  deps: InstallDeps
): Promise<{ ok: true; command: string; args: string[] } | { ok: false; error: string }> {
  if (deps.dirExistsNonEmpty(destDir)) {
    return { ok: false, error: `${destDir} exists and is not empty. Remove it or choose another directory — the installer never overwrites.` };
  }
  // The server's own build script is `bun build src/index.ts …`, so bun is not
  // optional. Fail here rather than half-way through, leaving a broken directory.
  const bun = deps.which('bun');
  if (!bun) {
    return { ok: false, error: 'bun was not found on PATH. The Trello MCP server builds with bun — install it (https://bun.sh) and try again.' };
  }

  const clone = deps.run('git', [
    'clone', '--depth', '1', '--branch', TRELLO_MCP_TAG, TRELLO_MCP_REPO_URL, destDir
  ]);
  if (!clone.ok) return { ok: false, error: `git clone failed: ${clone.stderr ?? 'unknown error'}` };

  const install = deps.run(bun, ['install'], destDir);
  if (!install.ok) return { ok: false, error: `bun install failed: ${install.stderr ?? 'unknown error'}` };

  const build = deps.run(bun, ['run', 'build'], destDir);
  if (!build.ok) return { ok: false, error: `bun run build failed: ${build.stderr ?? 'unknown error'}` };

  // Seed an EMPTY .env from whichever template the repo ships. Best-effort: a
  // missing template is not a failed install, it just means the user creates
  // the file themselves — the preflight tells them so either way.
  for (const template of ['.env.template', 'example.env']) {
    const from = join(destDir, template);
    if (deps.fileExists(from)) {
      deps.copyFile(from, join(destDir, '.env'));
      break;
    }
  }

  return { ok: true, command: bun, args: [join(destDir, 'build', 'index.js')] };
}

/** Production wiring of the installer. */
export function nodeInstallDeps(): InstallDeps {
  return {
    dirExistsNonEmpty: (p) => {
      try { return existsSync(p) && readdirSync(p).length > 0; } catch { return false; }
    },
    which: (bin) => {
      const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin], { encoding: 'utf8' });
      const out = (probe.stdout ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      return probe.status === 0 && out[0] ? out[0] : null;
    },
    run: (cmd, args, cwd) => {
      const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: 300_000 });
      return { ok: r.status === 0, stderr: (r.stderr ?? '').trim() || undefined };
    },
    fileExists: (p) => {
      try { return existsSync(p); } catch { return false; }
    },
    copyFile: (from, to) => copyFileSync(from, to)
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/mcp-provision.test.cjs`
Expected: PASS, 14 tests.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/main/mcpProvision.ts test/mcp-provision.test.cjs
git commit -m "feat(mcp): preflight for user-configured servers + pinned Trello installer"
```

---

### Task 6: Per-agent MCP scoping in the hive

**Files:**
- Modify: `src/main/hive.ts` (`buildDefaultMcpServers` ~line 1229, `hookSettings` ~line 1138, call site line 972)
- Test: `test/mcp-scoping.test.cjs`

**Interfaces:**
- Consumes: `McpConsent`, `checkMcpPresence`, `nodePresenceDeps` from Task 5; `userConfigured` from Task 3; the widened `McpDefaultsMap` from Task 4.
- Produces: `buildDefaultMcpServers(cwd: string, cfg: McpDefaultsMap, agentId: string)` and `hookSettings(shim: string, agentId: string, cwd: string, cfg: McpDefaultsMap, theme?, writableDirs?)` — both private; nothing later depends on them.

- [ ] **Step 1: Write the failing test**

Create `test/mcp-scoping.test.cjs`:

```javascript
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'md-mcp-scope-'));
const electronPath = require.resolve('electron');
require.cache[electronPath] = {
  id: electronPath, filename: electronPath, loaded: true,
  exports: { app: { getPath: () => userData, isPackaged: false, getAppPath: () => path.join(__dirname, '..') } }
};

const { HiveManager } = loadTs('src/main/hive.ts');

test.after(() => fs.rmSync(userData, { recursive: true, force: true }));

const hive = new HiveManager(() => userData);
const cwd = '/tmp/agent-cwd';

// `buildDefaultMcpServers` is private in TypeScript only — at run time it is a
// plain method, and calling it directly is far more precise than reconstructing
// a whole spawn just to read one block of the settings file.
function build(cfg, agentId) {
  return hive['buildDefaultMcpServers'](cwd, cfg, agentId);
}

/** A fully installed, credentialed Trello server on disk, so the preflight passes. */
function installedTrello() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'md-mcp-pkg-'));
  fs.mkdirSync(path.join(root, 'build'));
  fs.writeFileSync(path.join(root, 'build', 'index.js'), '// server');
  fs.writeFileSync(path.join(root, '.env'), 'TRELLO_API_KEY=k\nTRELLO_TOKEN=t\n');
  const command = path.join(root, 'bun');
  fs.writeFileSync(command, '#!/bin/sh\n');
  fs.chmodSync(command, 0o755);
  return { command, args: [path.join(root, 'build', 'index.js')] };
}

test('an unscoped consent still reaches every agent (regression)', () => {
  const cfg = { 'sequential-thinking': { enabled: true } };
  assert.ok(build(cfg, 'god')['munder-sequential-thinking']);
  assert.ok(build(cfg, 'worker-1')['munder-sequential-thinking']);
});

test('an agents-scoped consent reaches only the listed agents', () => {
  const { command, args } = installedTrello();
  const cfg = { trello: { enabled: true, agents: ['god'], command, args } };
  assert.ok(build(cfg, 'god')['munder-trello'], 'god should receive the scoped server');
  assert.equal(build(cfg, 'worker-1')['munder-trello'], undefined, 'a worker must not receive it');
});

test('an empty agents list means every agent, not none', () => {
  const { command, args } = installedTrello();
  const cfg = { trello: { enabled: true, agents: [], command, args } };
  assert.ok(build(cfg, 'worker-1')['munder-trello']);
});

test('a userConfigured entry uses the consent command and args', () => {
  const { command, args } = installedTrello();
  const cfg = { trello: { enabled: true, command, args } };
  const server = build(cfg, 'god')['munder-trello'];
  assert.equal(server.command, command);
  assert.deepEqual(server.args, args);
});

test('a userConfigured entry with no command is omitted, not written broken', () => {
  const cfg = { trello: { enabled: true } };
  assert.equal(build(cfg, 'god')['munder-trello'], undefined);
});

test('a userConfigured entry that fails its preflight is omitted', () => {
  const { command } = installedTrello();
  const cfg = { trello: { enabled: true, command, args: ['/nowhere/build/index.js'] } };
  assert.equal(build(cfg, 'god')['munder-trello'], undefined);
});

test('a command override is ignored for an entry that is not userConfigured', () => {
  const cfg = { 'sequential-thinking': { enabled: true, command: '/bin/evil', args: ['x'] } };
  const server = build(cfg, 'god')['munder-sequential-thinking'];
  assert.equal(server.command, 'npx', 'a hand-edited config must not swap a catalog server binary');
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/mcp-scoping.test.cjs`
Expected: FAIL — `buildDefaultMcpServers` takes two parameters, so `agentId` is undefined and the scoping assertions fail.

- [ ] **Step 3: Thread the agent id through**

In `src/main/hive.ts`:

Add the import next to the other main-process imports:

```ts
import { checkMcpPresence, nodePresenceDeps } from './mcpProvision';
```

Change the `hookSettings` signature (~line 1138) from:

```ts
  private hookSettings(shim: string, cwd: string, cfg: McpDefaultsMap, theme?: 'light' | 'dark', writableDirs: string[] = []): unknown {
```

to:

```ts
  private hookSettings(shim: string, agentId: string, cwd: string, cfg: McpDefaultsMap, theme?: 'light' | 'dark', writableDirs: string[] = []): unknown {
```

and inside it change the merge call to:

```ts
    const mcpServers = this.buildDefaultMcpServers(cwd, cfg, agentId);
```

Update the call site at line 972 to pass `meta.id`:

```ts
      this.writeJson(settingsPath, this.hookSettings(shim, meta.id, meta.cwd, opts.mcpDefaults, opts.theme, this.sandboxWritableDirs(meta, dir, root, opts.extraWritableDirs)));
```

- [ ] **Step 4: Apply the scoping rules**

Replace the body of `buildDefaultMcpServers` (~line 1229) with:

```ts
  private buildDefaultMcpServers(
    cwd: string,
    cfg: McpDefaultsMap,
    agentId: string
  ): Record<string, { command: string; args: string[]; env?: Record<string, string> }> {
    const out: Record<string, { command: string; args: string[]; env?: Record<string, string> }> = {};
    const presenceDeps = nodePresenceDeps();
    for (const e of MCP_CATALOG) {
      const consent = cfg?.[e.id];
      const consented = consent?.enabled;
      const enabled = consented ?? e.defaultEnabled;
      if (!enabled) continue;
      // Defense-in-depth: a write/secret server requires an EXPLICIT opt-in; it can
      // never ride in on a default (the catalog already ships these OFF, but this
      // guards a hand-edited/partial mcpDefaults map too).
      if (e.tier !== 'safe-readonly' && consented !== true) continue;
      // Per-agent scoping: an empty or absent list means every agent, which is
      // the behaviour every existing consent has.
      if (consent?.agents?.length && !consent.agents.includes(agentId)) continue;

      let command = e.spec.command;
      let args = e.spec.args.map((a) => (a === '<cwd>' ? cwd : a));
      // A consent may only supply a command for an entry that declares itself
      // user-configured. Without this guard a hand-edited config.json could turn
      // `filesystem` into an arbitrary binary launched inside every agent.
      if (e.userConfigured) {
        const custom = consent?.command?.trim();
        if (!custom || !consent?.args?.length) continue; // not configured yet — omit, never write a broken block
        const presence = checkMcpPresence(e.id, consent, presenceDeps);
        if (!presence.ok) {
          // A DECLARED-but-dead server is the worst outcome: the client retries
          // and the agent silently has no tools. Omit it and say why.
          console.error(`[hive] MCP '${e.id}' not wired for ${agentId}: ${presence.reason} — ${presence.detail ?? ''}`);
          continue;
        }
        command = custom;
        args = [...consent.args];
      }

      out[`munder-${e.id}`] = {
        command,
        args,
        ...(e.spec.env ? { env: e.spec.env } : {})
      };
    }
    return out;
  }
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test test/mcp-scoping.test.cjs`
Expected: PASS, 7 tests.

- [ ] **Step 6: Run the full focused suite and typecheck**

Run: `npm run typecheck && npm run test:focused`
Expected: no type errors; every test passes, including `test/deepcode-settings-merge.test.cjs`, which exercises the settings writer that now takes an extra argument.

- [ ] **Step 7: Commit**

```bash
git add src/main/hive.ts test/mcp-scoping.test.cjs
git commit -m "feat(hive): scope MCP servers per agent and preflight user-configured ones"
```

---

### Task 7: IPC + preload for preflight and install

**Files:**
- Modify: `src/main/index.ts` (two `ipcMain.handle` registrations, near `integrations:test` ~line 3220)
- Modify: `src/preload/index.ts` (two methods on `cth`, near `integrationsTest` ~line 1323)
- Test: `test/mcp-provision-ipc.test.cjs`

**Interfaces:**
- Consumes: `checkMcpPresence`, `nodePresenceDeps`, `installTrelloMcp`, `nodeInstallDeps`, `McpPresence` from Task 5.
- Produces: `window.cth.mcpPresence(id: string): Promise<McpPresence>` and `window.cth.mcpInstall(id: string): Promise<{ ok: true; command: string; args: string[] } | { ok: false; error: string }>` — consumed by Task 8.

- [ ] **Step 1: Write the failing test**

Create `test/mcp-provision-ipc.test.cjs`. This asserts the wiring contract by reading the source, the same way a handler with heavy electron dependencies is normally pinned in this repo:

```javascript
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'src/main/index.ts'), 'utf8');
const preloadSrc = fs.readFileSync(path.join(__dirname, '..', 'src/preload/index.ts'), 'utf8');

test('main registers the two provisioning handlers', () => {
  assert.match(mainSrc, /ipcMain\.handle\('mcp:presence'/);
  assert.match(mainSrc, /ipcMain\.handle\('mcp:install'/);
});

test('install is confined to the app userData directory', () => {
  const block = mainSrc.slice(mainSrc.indexOf("ipcMain.handle('mcp:install'"));
  assert.match(block.slice(0, 900), /getPath\('userData'\)/, 'the destination must be derived in main, never taken from the renderer');
});

test('preload exposes both methods', () => {
  assert.match(preloadSrc, /mcpPresence:/);
  assert.match(preloadSrc, /mcpInstall:/);
});

test('the renderer cannot choose the install directory', () => {
  const call = preloadSrc.slice(preloadSrc.indexOf('mcpInstall:'), preloadSrc.indexOf('mcpInstall:') + 220);
  assert.equal(/destDir|path/.test(call), false, 'mcpInstall must take an id only');
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/mcp-provision-ipc.test.cjs`
Expected: FAIL — none of those strings exist yet.

- [ ] **Step 3: Register the handlers**

In `src/main/index.ts`, add to the imports:

```ts
import { checkMcpPresence, nodePresenceDeps, installTrelloMcp, nodeInstallDeps } from './mcpProvision';
```

and immediately after the `integrations:test` handler (~line 3224) add:

```ts
// ─── IPC: MCP provisioning ──────────────────────────────────────────────────

ipcMain.handle('mcp:presence', async (_evt, payload: unknown) => {
  const p = (payload ?? {}) as { id?: unknown };
  if (typeof p.id !== 'string' || !p.id) return { ok: false, reason: 'not_configured', detail: 'id required' };
  return checkMcpPresence(p.id, readConfig().mcpDefaults?.[p.id], nodePresenceDeps());
});

ipcMain.handle('mcp:install', async (_evt, payload: unknown) => {
  const p = (payload ?? {}) as { id?: unknown };
  if (p.id !== 'trello') return { ok: false, error: 'only the trello MCP server has an installer' };
  // The destination is derived HERE, never accepted from the renderer: an
  // installer that clones wherever it is told is an arbitrary-write primitive.
  const destDir = join(app.getPath('userData'), 'mcp', 'trello');
  return installTrelloMcp(destDir, nodeInstallDeps());
});
```

If `join` or `app` is not already imported in that file, use the existing imports at the top rather than adding duplicates.

- [ ] **Step 4: Expose them in preload**

In `src/preload/index.ts`, add next to `integrationsTest` (~line 1323):

```ts
  /** Can this MCP server actually run right now? Never returns a credential —
   *  the detail names a missing key, never its value. */
  mcpPresence: (id: string): Promise<{ ok: boolean; reason?: string; detail?: string }> =>
    ipcRenderer.invoke('mcp:presence', { id }),
  /** Clone + build a user-configured MCP server. The destination is chosen by
   *  main, not here. */
  mcpInstall: (id: string): Promise<{ ok: true; command: string; args: string[] } | { ok: false; error: string }> =>
    ipcRenderer.invoke('mcp:install', { id }),
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test test/mcp-provision-ipc.test.cjs`
Expected: PASS, 4 tests.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/main/index.ts src/preload/index.ts test/mcp-provision-ipc.test.cjs
git commit -m "feat(ipc): expose MCP preflight and Trello server install"
```

---

### Task 8: Settings UI for user-configured MCP servers

**Files:**
- Modify: `src/renderer/src/components/McpDefaultsSettings.tsx`
- Modify: `src/renderer/src/i18n/locales/en.json`, `zh-CN.json`, `ar.json`
- Test: `test/mcp-defaults-ui-i18n.test.cjs`

**Interfaces:**
- Consumes: `window.cth.mcpPresence`, `window.cth.mcpInstall` from Task 7; `userConfigured` from Task 3; the widened `mcpDefaults` from Task 4.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Write the failing test**

Create `test/mcp-defaults-ui-i18n.test.cjs`:

```javascript
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const LOCALES = ['en', 'zh-CN', 'ar'];
const KEYS = [
  'command', 'commandHint', 'args', 'argsHint', 'agents', 'agentsHint',
  'install', 'installing', 'installFailed', 'presenceOk',
  'presence.not_configured', 'presence.command_missing',
  'presence.entry_missing', 'presence.credentials_missing'
];

function read(locale) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src/renderer/src/i18n/locales', `${locale}.json`), 'utf8'));
}

function at(obj, dotted) {
  return dotted.split('.').reduce((acc, part) => (acc == null ? undefined : acc[part]), obj);
}

for (const locale of LOCALES) {
  test(`${locale} has every new mcpDefaults string`, () => {
    const mcp = read(locale).mcpDefaults;
    assert.ok(mcp, `${locale} has no mcpDefaults block`);
    for (const key of KEYS) {
      const value = at(mcp, key);
      assert.ok(typeof value === 'string' && value.length > 0, `${locale} is missing mcpDefaults.${key}`);
    }
  });
}

test('the component renders the extra fields only for user-configured entries', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/src/components/McpDefaultsSettings.tsx'), 'utf8');
  assert.match(src, /userConfigured/, 'the extra fields must be gated on the catalog flag');
  assert.match(src, /mcpPresence/, 'the preflight state must be shown');
  assert.match(src, /mcpInstall/, 'the install action must be wired');
  assert.match(src, /credentials_missing/, 'the install button must be hidden for credentials_missing');
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/mcp-defaults-ui-i18n.test.cjs`
Expected: FAIL — none of the new i18n keys exist.

- [ ] **Step 3: Add the i18n strings**

Add to the `mcpDefaults` block of `src/renderer/src/i18n/locales/en.json`:

```json
      "command": "Launch command",
      "commandHint": "Absolute path to the binary that runs the server (e.g. the bun executable).",
      "args": "Arguments",
      "argsHint": "One per line. The first one is the server's entry file.",
      "agents": "Agents allowed",
      "agentsHint": "Comma-separated agent ids. Leave empty to give this server to every agent.",
      "install": "Install",
      "installing": "Installing…",
      "installFailed": "Install failed: {{error}}",
      "presenceOk": "Ready",
      "presence": {
        "not_configured": "Not configured yet — set the launch command below, or install the server.",
        "command_missing": "The launch command is not an executable file.",
        "entry_missing": "The server's entry file is missing — it may need to be built.",
        "credentials_missing": "The server has no credentials yet. {{detail}}"
      }
```

Add the same keys, translated, to `zh-CN.json` and `ar.json`. Keep the `{{error}}` and `{{detail}}` placeholders verbatim in every locale.

- [ ] **Step 4: Fix the consent-clobbering bug the widened shape exposes**

`toggle` currently writes `{ enabled: next }`, replacing the whole consent
entry. That was harmless when `enabled` was the only field; now it would erase a
configured `command`/`args`/`agents` every time the user flips a server off and
on. In `McpDefaultsSettings.tsx`, replace the body of `toggle` with:

```tsx
  const toggle = async (id: string) => {
    const next = !enabledFor(id);
    try {
      await window.cth.updateConfig({
        // Spread the existing entry: enabled is no longer the only field, and
        // replacing the object would wipe a configured command/args/agents.
        mcpDefaults: {
          ...(config.mcpDefaults ?? {}),
          [id]: { ...(config.mcpDefaults?.[id] ?? {}), enabled: next }
        }
      });
      setNote(t('mcpDefaults.toggleNote', { id, state: next ? t('common.on') : t('common.off') }));
      setTimeout(() => setNote(''), 1800);
    } catch {
      setNote(t('mcpDefaults.couldNotSave'));
      setTimeout(() => setNote(''), 2000);
    }
  };
```

- [ ] **Step 5: Add the state, the preflight and the save helper**

Still in `McpDefaultsSettings.tsx`, add `useEffect` to the React import, then add
this above the `byTier` helper:

```tsx
  const [presence, setPresence] = useState<Record<string, { ok: boolean; reason?: string; detail?: string }>>({});
  const [installing, setInstalling] = useState<string | null>(null);

  /** Re-run the preflight for every user-configured entry. Cheap (a few stat
   *  calls in main) and re-run after each save, because every field the user
   *  edits here is an input to it. */
  const refreshPresence = async () => {
    const configured = MCP_CATALOG.filter((e) => e.userConfigured);
    const results = await Promise.all(configured.map((e) => window.cth.mcpPresence(e.id)));
    setPresence(Object.fromEntries(configured.map((e, i) => [e.id, results[i]])));
  };

  useEffect(() => { void refreshPresence(); }, []);

  /** Merge a partial consent for one entry and re-run its preflight. */
  const patchConsent = async (id: string, p: { command?: string; args?: string[]; agents?: string[] }) => {
    const current = config.mcpDefaults?.[id] ?? { enabled: enabledFor(id) };
    try {
      await window.cth.updateConfig({
        mcpDefaults: { ...(config.mcpDefaults ?? {}), [id]: { ...current, ...p } }
      });
      await refreshPresence();
    } catch {
      setNote(t('mcpDefaults.couldNotSave'));
      setTimeout(() => setNote(''), 2000);
    }
  };

  const onInstall = async (id: string) => {
    setInstalling(id);
    try {
      const res = await window.cth.mcpInstall(id);
      if (!res.ok) {
        setNote(t('mcpDefaults.installFailed', { error: res.error }));
        setTimeout(() => setNote(''), 4000);
        return;
      }
      await patchConsent(id, { command: res.command, args: res.args });
    } finally {
      setInstalling(null);
    }
  };
```

- [ ] **Step 6: Render the extra fields for user-configured entries**

Inside the `entries.map((entry) => {` block, immediately after the closing
`</button>` of the on/off toggle and before the closing `</div>` of the row,
the row must become a column so the fields can sit under the toggle. Change the
row's `style` from `flexDirection` default to an explicit wrapper: keep the
existing header row as-is inside a new `<div style={{ display: 'flex',
flexDirection: 'column', gap: 6, flex: 1, minWidth: 0 }}>` and append:

```tsx
                    {entry.userConfigured && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 }}>
                        <span style={{ fontSize: 11, lineHeight: '15px', color: presence[entry.id]?.ok ? 'var(--cth-mint)' : '#6E1423' }}>
                          {presence[entry.id]?.ok
                            ? t('mcpDefaults.presenceOk')
                            : t(`mcpDefaults.presence.${presence[entry.id]?.reason ?? 'not_configured'}`, { detail: presence[entry.id]?.detail ?? '' })}
                        </span>

                        <label style={labelStyle}>{t('mcpDefaults.command')}</label>
                        <input
                          defaultValue={config.mcpDefaults?.[entry.id]?.command ?? ''}
                          onBlur={(e) => { void patchConsent(entry.id, { command: e.target.value.trim() }); }}
                          style={{ width: '100%', padding: '6px 8px', background: 'var(--cth-paper-100)', border: 'none', boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)', fontSize: 12, color: 'var(--cth-ink-900)' }}
                        />
                        <span style={{ fontSize: 11, color: 'var(--cth-ink-500)' }}>{t('mcpDefaults.commandHint')}</span>

                        <label style={labelStyle}>{t('mcpDefaults.args')}</label>
                        <textarea
                          rows={2}
                          defaultValue={(config.mcpDefaults?.[entry.id]?.args ?? []).join('\n')}
                          onBlur={(e) => {
                            void patchConsent(entry.id, {
                              args: e.target.value.split('\n').map((a) => a.trim()).filter(Boolean)
                            });
                          }}
                          style={{ width: '100%', padding: '6px 8px', background: 'var(--cth-paper-100)', border: 'none', boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)', fontSize: 12, color: 'var(--cth-ink-900)' }}
                        />
                        <span style={{ fontSize: 11, color: 'var(--cth-ink-500)' }}>{t('mcpDefaults.argsHint')}</span>

                        <label style={labelStyle}>{t('mcpDefaults.agents')}</label>
                        <input
                          defaultValue={(config.mcpDefaults?.[entry.id]?.agents ?? []).join(', ')}
                          onBlur={(e) => {
                            void patchConsent(entry.id, {
                              agents: e.target.value.split(',').map((a) => a.trim()).filter(Boolean)
                            });
                          }}
                          style={{ width: '100%', padding: '6px 8px', background: 'var(--cth-paper-100)', border: 'none', boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)', fontSize: 12, color: 'var(--cth-ink-900)' }}
                        />
                        <span style={{ fontSize: 11, color: 'var(--cth-ink-500)' }}>{t('mcpDefaults.agentsHint')}</span>

                        {/* No install button for credentials_missing: no install can
                            fix it, only the user editing the server's own .env. */}
                        {entry.id === 'trello'
                          && !presence[entry.id]?.ok
                          && presence[entry.id]?.reason !== 'credentials_missing' && (
                          <button
                            type="button"
                            disabled={installing === entry.id}
                            onClick={() => { void onInstall(entry.id); }}
                            style={{
                              alignSelf: 'flex-start', padding: '3px 10px 1px',
                              background: 'var(--cth-cream-200)',
                              boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)',
                              border: 'none', fontFamily: 'var(--cth-font-display)',
                              fontSize: 8, lineHeight: '14px', color: 'var(--cth-ink-900)',
                              cursor: installing === entry.id ? 'default' : 'pointer',
                              textTransform: 'uppercase'
                            }}
                          >
                            {installing === entry.id ? t('mcpDefaults.installing') : t('mcpDefaults.install')}
                          </button>
                        )}
                      </div>
                    )}
```

Every non-`userConfigured` entry renders exactly as it does today: the whole
block is behind `entry.userConfigured &&`.

- [ ] **Step 7: Run the test to verify it passes**

Run: `node --test test/mcp-defaults-ui-i18n.test.cjs`
Expected: PASS, 4 tests.

- [ ] **Step 8: Typecheck**

Run: `npm run typecheck`
Expected: no errors — in particular `typecheck:web` must accept the new `cth` methods, which come from the preload types added in Task 7.

- [ ] **Step 9: Commit**

```bash
git add src/renderer/src/components/McpDefaultsSettings.tsx src/renderer/src/i18n/locales/en.json src/renderer/src/i18n/locales/zh-CN.json src/renderer/src/i18n/locales/ar.json test/mcp-defaults-ui-i18n.test.cjs
git commit -m "feat(ui): configure, preflight and install user-configured MCP servers"
```

---

### Task 9: Trello source subsection in the project registry

**Files:**
- Modify: `src/renderer/src/components/JiraProjectsRegistry.tsx`
- Modify: `src/renderer/src/i18n/locales/en.json`, `zh-CN.json`, `ar.json`
- Test: `test/trello-intake-ui-i18n.test.cjs`

**Interfaces:**
- Consumes: `TrelloIntakeBinding`, `parseTrelloBoardUrl`, `validateTrelloIntake` from Task 1; `JiraProjectBinding.trello` from Task 2; the existing `window.cth.jiraProjectsUpsert`.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Write the failing test**

Create `test/trello-intake-ui-i18n.test.cjs`:

```javascript
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const LOCALES = ['en', 'zh-CN', 'ar'];
const KEYS = [
  'trelloTitle', 'trelloAdd', 'trelloRemove', 'trelloBoardUrl', 'trelloBoardUrlHint',
  'trelloBoardLabel', 'trelloLists', 'trelloListsHint', 'trelloEnabled', 'trelloBadUrl'
];

function read(locale) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src/renderer/src/i18n/locales', `${locale}.json`), 'utf8'));
}

for (const locale of LOCALES) {
  test(`${locale} has every new jiraProjects string`, () => {
    const block = read(locale).jiraProjects;
    assert.ok(block, `${locale} has no jiraProjects block`);
    for (const key of KEYS) {
      assert.ok(typeof block[key] === 'string' && block[key].length > 0, `${locale} is missing jiraProjects.${key}`);
    }
  });
}

test('the registry parses the board URL and does not ask for a raw id', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/src/components/JiraProjectsRegistry.tsx'), 'utf8');
  assert.match(src, /parseTrelloBoardUrl/, 'the board URL must be parsed, not pasted as an id');
  assert.match(src, /trelloBoardUrl/);
  assert.match(src, /intakeLists/);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test test/trello-intake-ui-i18n.test.cjs`
Expected: FAIL — none of the new keys exist.

- [ ] **Step 3: Add the i18n strings**

Add to the `jiraProjects` block of `en.json`:

```json
    "trelloTitle": "Trello source",
    "trelloAdd": "Add a Trello source",
    "trelloRemove": "Remove the Trello source",
    "trelloBoardUrl": "Board URL",
    "trelloBoardUrlHint": "Paste the board URL, e.g. https://trello.com/b/781LrPy9/burdastyle",
    "trelloBoardLabel": "Board name",
    "trelloLists": "Intake lists",
    "trelloListsHint": "One list name per line, exactly as it appears on the board. Cards in these lists become issues of this project.",
    "trelloEnabled": "Intake enabled",
    "trelloBadUrl": "That is not a Trello board URL. It must look like https://trello.com/b/<id>/<name>."
```

Add the same keys, translated, to `zh-CN.json` and `ar.json`.

- [ ] **Step 4: Carry the Trello source through the draft**

In `src/renderer/src/components/JiraProjectsRegistry.tsx`, add the import:

```ts
import { parseTrelloBoardUrl, validateTrelloIntake, type TrelloIntakeBinding } from '@shared/trelloIntake';
```

Add a field to `Draft` (after `enabled: boolean;`):

```ts
  /** Trello source, or undefined when this project has none. The raw URL is
   *  kept beside it so the input can show what the user typed even when it
   *  does not parse. */
  trello?: TrelloIntakeBinding;
  trelloUrl: string;
```

and thread it through the three converters:

```ts
function draftFromBinding(b: JiraProjectBinding): Draft {
  return {
    isNew: false, key: b.key, repo: b.repo, baseBranch: b.baseBranch,
    agents: b.agents ?? [], enabled: b.enabled,
    trello: b.trello,
    trelloUrl: b.trello ? `https://trello.com/b/${b.trello.boardShortLink}` : ''
  };
}
function emptyDraft(): Draft {
  return { isNew: true, key: '', repo: '', baseBranch: '', agents: [], enabled: true, trelloUrl: '' };
}
function bindingFromDraft(d: Draft): JiraProjectBinding {
  return {
    key: d.key.trim().toUpperCase(),
    repo: d.repo.trim(),
    baseBranch: d.baseBranch.trim(),
    agents: d.agents.length > 0 ? d.agents : undefined,
    enabled: d.enabled,
    ...(d.trello ? { trello: d.trello } : {})
  };
}
```

- [ ] **Step 5: Validate the source before the round trip**

In `onSave`, replace the first two lines of the `try` block so the local check
runs first (main validates again — this just spares a round trip and names the
field while the user is still looking at it):

```tsx
    try {
      if (draft.trello) {
        const trelloError = validateTrelloIntake(draft.trello);
        if (trelloError) { setErr(trelloError); return; }
      }
      const res = await jiraProjectsClient.save(bindingFromDraft(draft));
```

Note the existing `finally { setBusy(false); }` already covers the early return.

- [ ] **Step 6: Render the Trello source subsection**

In the configure view, directly after the `baseBranch` field block (~line 294),
insert:

```tsx
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={fieldLabel}>{tr('jiraProjects.trelloTitle')}</span>

            {!draft.trello && (
              <PixelButton
                onClick={() => patch({
                  trello: { boardShortLink: '', boardLabel: '', intakeLists: [], enabled: true },
                  trelloUrl: ''
                })}
              >
                {tr('jiraProjects.trelloAdd')}
              </PixelButton>
            )}

            {draft.trello && (
              <>
                <span style={fieldLabel}>{tr('jiraProjects.trelloBoardUrl')}</span>
                <input
                  value={draft.trelloUrl}
                  onChange={(e) => {
                    const url = e.target.value;
                    const short = parseTrelloBoardUrl(url);
                    // The slug is lowercase and hyphenated, so it is a starting
                    // point for the label, never the final answer — the field
                    // stays editable and the user is expected to fix the casing.
                    const slug = url.split('/').filter(Boolean).pop() ?? '';
                    const current = draft.trello as TrelloIntakeBinding;
                    patch({
                      trelloUrl: url,
                      trello: {
                        ...current,
                        boardShortLink: short ?? '',
                        boardLabel: current.boardLabel || (short ? slug : '')
                      }
                    });
                    setErr(url && !short ? tr('jiraProjects.trelloBadUrl') : '');
                  }}
                  style={inputStyle}
                />
                <span style={hint}>{tr('jiraProjects.trelloBoardUrlHint')}</span>

                <span style={fieldLabel}>{tr('jiraProjects.trelloBoardLabel')}</span>
                <input
                  value={draft.trello.boardLabel}
                  onChange={(e) => patch({ trello: { ...(draft.trello as TrelloIntakeBinding), boardLabel: e.target.value } })}
                  style={inputStyle}
                />

                <span style={fieldLabel}>{tr('jiraProjects.trelloLists')}</span>
                <textarea
                  rows={3}
                  value={draft.trello.intakeLists.join('\n')}
                  onChange={(e) => patch({
                    trello: {
                      ...(draft.trello as TrelloIntakeBinding),
                      // Keep every line the user typed, blanks included: dropping
                      // them here would make a trailing newline silently delete a
                      // name mid-edit. validateTrelloIntake rejects blanks on save.
                      intakeLists: e.target.value.split('\n')
                    }
                  })}
                  style={inputStyle}
                />
                <span style={hint}>{tr('jiraProjects.trelloListsHint')}</span>

                <label style={{ display: 'flex', alignItems: 'center', gap: 6, ...subText }}>
                  <input
                    type="checkbox"
                    checked={draft.trello.enabled}
                    onChange={(e) => patch({ trello: { ...(draft.trello as TrelloIntakeBinding), enabled: e.target.checked } })}
                  />
                  {tr('jiraProjects.trelloEnabled')}
                </label>

                <PixelButton onClick={() => patch({ trello: undefined, trelloUrl: '' })}>
                  {tr('jiraProjects.trelloRemove')}
                </PixelButton>
              </>
            )}
          </div>
```

The whole binding, `trello` included, goes through the existing
`jiraProjectsClient.save`. No new IPC.

- [ ] **Step 7: Run the test to verify it passes**

Run: `node --test test/trello-intake-ui-i18n.test.cjs`
Expected: PASS, 4 tests.

- [ ] **Step 8: Typecheck and run the whole suite**

Run: `npm run typecheck && npm run test:focused`
Expected: no type errors; every test passes.

- [ ] **Step 9: Commit**

```bash
git add src/renderer/src/components/JiraProjectsRegistry.tsx src/renderer/src/i18n/locales/en.json src/renderer/src/i18n/locales/zh-CN.json src/renderer/src/i18n/locales/ar.json test/trello-intake-ui-i18n.test.cjs
git commit -m "feat(ui): bind a Trello board and its intake lists to a Jira project"
```

---

## Manual verification (after Task 9)

The automated suite never launches Trello or Jira. Do this once, by hand, before calling the feature done:

1. Start the app. In Settings → Connections → MCP defaults, the **Trello (read-only intake)** entry shows `not_configured`.
2. Either press **Install** (clones `v1.8.0` into `<userData>/mcp/trello`, builds it) or point the command/args at the existing checkout at `/Users/shaibon/www/magenio-mcp/trello-mcp`. The state becomes `credentials_missing` after a fresh install.
3. Fill in `TRELLO_API_KEY` and `TRELLO_TOKEN` in that package's `.env`. The state becomes **Ready**.
4. Set **Agents allowed** to `god`.
5. In Settings → Connections → Jira Projects, open the `BURD` binding, add a Trello source with `https://trello.com/b/781LrPy9/burdastyle` and the intake list `Approvati`, and save.
6. In the Schedules panel, enable the `trello-intake` mission and fire it once.
7. Confirm: god reports the cards it read; a Jira issue exists for each untracked card, unassigned, labelled `trello-<shortLink>`, with a remote link to the card. Confirm the Trello board is **byte-for-byte unchanged** — no comments, no moved cards, no new labels.
8. Fire the mission a second time. Confirm it creates **nothing** and reports every card as already tracked. This is the deduplication check and it is the one that matters.
9. Spawn a normal worker and confirm its session `settings.json` has no `munder-trello` entry.
