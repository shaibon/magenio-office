/** Seconds since an agent was last active, for fleet.json and the roster (t-296).
 *  Providers with OTel/hook telemetry report real activity (`usageTs`). A provider that has none —
 *  DeepCode's only hook is a per-turn notify, so a whole first turn is silent — would read as null and
 *  look dead while it works, so its terminal output stands in. Never mixed with telemetry: a terminal
 *  redraw must not make an idle Claude agent look active. */
export function lastActiveSecAgo(now: number, usageTs: number | undefined, ptyOutputAt: number | undefined): number | null {
  if (usageTs !== undefined) return Math.round((now - usageTs) / 1000);
  if (ptyOutputAt && ptyOutputAt > 0) return Math.max(0, Math.round((now - ptyOutputAt) / 1000));
  return null;
}
