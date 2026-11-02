/** Fleet/roster activity fields for one agent (t-296). Telemetry (OTel usage + tool spans) is the source
 *  when an agent has it. DeepCode has none, but writes its own session files during the turn (see
 *  main/deepcodeSession.ts), which are a real source; nothing is inferred from terminal output. */
export interface ActivitySources {
  usageTs?: number;
  usageTokens?: number;
  lastSpanTool?: string | null;
  /** Present only for a DeepCode agent whose own session could be identified. */
  deepcode?: { status: string | null; updatedAt: number | null; totalTokens: number | null; lastTool: string | null } | null;
  /** The agent has a live process (a stale 'processing' left by a dead one must not read as working). */
  live?: boolean;
}

export interface FleetActivity {
  lastActiveSecAgo: number | null;
  lastTool: string | null;
  tokens: number | null;
  /** 'working' while DeepCode reports a turn in progress (a long model or tool wait writes nothing, so
   *  lastActiveSecAgo alone would read as idle); 'waiting' when it is asking the user. Otherwise null. */
  turn: 'working' | 'waiting' | null;
}

export function fleetActivity(now: number, src: ActivitySources): FleetActivity {
  if (src.usageTs !== undefined) {
    return { lastActiveSecAgo: Math.round((now - src.usageTs) / 1000), lastTool: src.lastSpanTool ?? null, tokens: src.usageTokens ?? null, turn: null };
  }
  const d = src.deepcode;
  if (d) {
    const turn = src.live ? (d.status === 'processing' ? 'working' : d.status === 'waiting_for_user' ? 'waiting' : null) : null;
    return {
      lastActiveSecAgo: d.updatedAt === null ? null : Math.max(0, Math.round((now - d.updatedAt) / 1000)),
      lastTool: d.lastTool,
      tokens: d.totalTokens,
      turn
    };
  }
  return { lastActiveSecAgo: null, lastTool: src.lastSpanTool ?? null, tokens: src.usageTokens ?? null, turn: null };
}
