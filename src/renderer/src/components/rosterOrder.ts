/**
 * Project-group order + collapse state for the fullscreen roster.
 * Import-free so it is unit-testable (same reason as askMeOrder.ts).
 */

/** Saved order applied to the live group keys: saved keys first (in saved
 *  order, dropping ones no longer present), then new keys in first-seen order. */
export function applyOrder(keys: string[], saved: string[]): string[] {
  const live = new Set(keys);
  const out = saved.filter((k, i) => live.has(k) && saved.indexOf(k) === i);
  const seen = new Set(out);
  for (const k of keys) if (!seen.has(k)) out.push(k);
  return out;
}

/** Move `from` to the slot `to` currently occupies. Unknown keys: no-op. */
export function moveKey(order: string[], from: string, to: string): string[] {
  const a = order.indexOf(from);
  const b = order.indexOf(to);
  if (a < 0 || b < 0 || a === b) return order;
  const next = order.slice();
  next.splice(a, 1);
  next.splice(b, 0, from);
  return next;
}

/** Tolerant parse of a persisted JSON string array; anything else → []. */
export function parseKeys(raw: string | null): string[] {
  try {
    const v = JSON.parse(raw ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch { return []; }
}
