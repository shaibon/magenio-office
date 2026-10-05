import { useEffect, useState } from 'react';
import type { IdeSession } from '@shared/ideSession';
import { useDirectionSync } from '@/i18n/useDirection';
import '@/design/theme'; // stamps the saved light/dark theme on <html>
import { IdePanel } from './IdePanel';

// StrictMode runs effects twice in dev and the snapshot can be taken only once,
// so the request lives at module level and every mount awaits the same promise.
let sessionPromise: Promise<IdeSession | null> | null = null;
const takeOnce = (): Promise<IdeSession | null> => (sessionPromise ??= window.cth.ideTakeSession());

/** Root of the popped-out IDE window (`#ide`): the IDE panel and nothing else. */
export function IdeWindow() {
  useDirectionSync();
  const [session, setSession] = useState<IdeSession | null | undefined>(undefined);
  useEffect(() => { void takeOnce().then(setSession); }, []);
  // No snapshot (the window was reloaded): nothing to show, so close it.
  useEffect(() => { if (session === null) window.close(); }, [session]);
  if (!session) return null;
  return <IdePanel mode="window" session={session} />;
}
