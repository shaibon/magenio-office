/**
 * Whether the "Install" action should be offered for a user-configured MCP
 * catalog entry, given its latest preflight result. Pulled out as a pure,
 * exported function (in its own plain `.ts` module — no JSX, no React
 * dependency) so it can be unit-tested directly through the shared
 * `test/load-ts.cjs` loader (this repo has no DOM test harness to drive the
 * button through the real component).
 *
 * - Only `trello` ships an installer today (Task 7) — every other
 *   user-configured entry has no install action to offer at all.
 * - Never once the preflight reports `ok`: nothing left to fix.
 * - Never for `credentials_missing`: no install can supply a secret: only
 *   the user editing the server's own `.env` can.
 * - Yes for `not_configured`, `command_missing`, `entry_missing`: an install
 *   can resolve each of those.
 * - An absent/unknown reason (in particular: preflight hasn't run yet, or
 *   reports a reason this UI doesn't recognize) is treated the same as an
 *   installable failure and defaults to showing the button. Hiding it on an
 *   unrecognized reason would silently strand the user with no way to
 *   recover a broken install; showing it when it isn't needed is at worst a
 *   redundant click that reruns an install which then reports `ok`.
 */
export function canInstallMcp(entryId: string, presence?: { ok: boolean; reason?: string }): boolean {
  if (entryId !== 'trello') return false;
  if (presence?.ok) return false;
  if (presence?.reason === 'credentials_missing') return false;
  return true;
}
