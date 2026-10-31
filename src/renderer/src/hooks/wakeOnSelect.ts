/** Wake-on-select (t-285): only a selection the user made may wake a sleeping agent. The boot restore
 *  adds every agent with addAgent, which selects each one in turn, then puts the user's old selection
 *  back — none of that is the user opening a tab. */
export function selectionWakes(prev: string | null, next: string | null, restoring: boolean): boolean {
  return !!next && next !== prev && !restoring;
}
