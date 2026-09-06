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
  /** shortLink of the board, taken from its URL (e.g. "AbCd1234"). Immutable,
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

/**
 * The intake list names as they must be STORED: each trimmed, blanks dropped.
 *
 * The mission matches list names against the live board EXACTLY, so a stored
 * `"Da fare "` — trivially produced by pasting a list name out of Trello, and
 * accepted by `validateTrelloIntake`, which trims only for checking — is a
 * permanent silent zero-intake for that binding. This is the counterpart to
 * that trim: it returns the normalized names instead of merely tolerating
 * them, so what was validated and what is persisted are the same strings.
 *
 * Dropping blanks is deliberate and belongs HERE, not in the editor: a form
 * that filters while the user types makes a trailing newline delete a name
 * mid-edit, while a trailing newline that survives to the commit boundary is
 * an invisible empty line the validator would reject with a message pointing
 * at nothing. An all-blank list still normalizes to `[]`, which
 * `validateTrelloIntake` rejects with "At least one intake list is required."
 */
export function normalizeIntakeLists(names: readonly string[] | undefined): string[] {
  return (names ?? []).map((n) => (n ?? '').trim()).filter(Boolean);
}

/** Returns an error message, or null when the intake binding is valid. */
export function validateTrelloIntake(t: TrelloIntakeBinding): string | null {
  const short = (t.boardShortLink ?? '').trim();
  if (!short) return 'A Trello board URL is required.';
  if (!TRELLO_SHORTLINK_RE.test(short)) {
    return 'The Trello board id must be the 8-character short link from the board URL (e.g. "AbCd1234").';
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
