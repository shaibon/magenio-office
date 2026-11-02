import { useSyncExternalStore } from 'react';
import { createAgentTurnsStore, type TurnState } from './agentTurnsStore';

const store = createAgentTurnsStore(() => window.cth);

/** Agents mid-turn right now (DeepCode), keyed by id. */
export function useAgentTurns(): Readonly<Record<string, TurnState>> {
  return useSyncExternalStore(store.subscribe, store.snapshot);
}

/** The status to SHOW once a turn in progress is known: working replaces idle only (a silent wait never
 *  overrides a state the terminal parser already knows, e.g. blocked). */
export function withTurn<S extends string>(status: S, turn: TurnState | undefined): S | 'working' {
  return turn === 'working' && status === 'idle' ? 'working' : status;
}
