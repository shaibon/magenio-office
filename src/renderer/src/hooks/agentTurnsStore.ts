/** Which agents are mid-turn right now, from main (t-296). DeepCode reports nothing between turns, so
 *  its card would read idle through a long silent model or tool wait; main reads the CLI's own session
 *  files. Display-only, polled while something is subscribed. */
export type TurnState = 'working' | 'waiting';
export interface TurnsBridge { agentTurns?: () => Promise<Record<string, TurnState>> }

export function createAgentTurnsStore(bridge: () => TurnsBridge, pollMs = 8000) {
  let turns: Readonly<Record<string, TurnState>> = {};
  const listeners = new Set<() => void>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let generation = 0;

  const refresh = (): void => {
    const g = ++generation; // an older reply must not overwrite a newer one
    void Promise.resolve(bridge().agentTurns?.()).then((next) => {
      if (g !== generation || !next) return;
      const a = Object.keys(turns), b = Object.keys(next);
      if (a.length === b.length && a.every((k) => turns[k] === next[k])) return;
      turns = next;
      listeners.forEach((l) => l());
    }).catch(() => { /* keep what we have */ });
  };

  const subscribe = (l: () => void): (() => void) => {
    if (!listeners.size) {
      refresh();
      timer = setInterval(refresh, pollMs);
      (timer as { unref?: () => void }).unref?.();
    }
    listeners.add(l);
    return () => {
      listeners.delete(l);
      if (!listeners.size && timer) { clearInterval(timer); timer = undefined; }
    };
  };
  return { subscribe, refresh, snapshot: () => turns };
}
