/** Fleet/roster activity fields for one agent (t-296). Telemetry (OTel usage + tool spans) is the source
 *  when an agent has it. DeepCode has none, but writes its own session files during the turn (see
 *  main/deepcodeSession.ts), which are a real source; nothing is inferred from terminal output. */
export interface ActivitySources {
  usageTs?: number;
  usageTokens?: number;
  lastSpanTool?: string | null;
  /** Present only for a DeepCode agent whose session files could be read. */
  deepcode?: { updatedAt: number | null; totalTokens: number | null; lastTool: string | null } | null;
}

export function fleetActivity(now: number, src: ActivitySources): { lastActiveSecAgo: number | null; lastTool: string | null; tokens: number | null } {
  if (src.usageTs !== undefined) {
    return { lastActiveSecAgo: Math.round((now - src.usageTs) / 1000), lastTool: src.lastSpanTool ?? null, tokens: src.usageTokens ?? null };
  }
  const d = src.deepcode;
  if (d) {
    return {
      lastActiveSecAgo: d.updatedAt === null ? null : Math.max(0, Math.round((now - d.updatedAt) / 1000)),
      lastTool: d.lastTool,
      tokens: d.totalTokens
    };
  }
  return { lastActiveSecAgo: null, lastTool: src.lastSpanTool ?? null, tokens: src.usageTokens ?? null };
}
