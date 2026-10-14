/**
 * Did a CLI die at startup because `--resume <id>` named a session it does not
 * know? Matched on the messages seen in hive/crashes (deepcode: "No saved session
 * found with ID …", "Invalid session ID: … Must be a valid UUID"). Import-free.
 */
export const RESUME_RETRY_WINDOW_MS = 15_000;

export function isResumeFailure(tail: string | undefined): boolean {
  return !!tail && /No saved session found|Invalid session ID|session (?:id )?not found/i.test(tail);
}

/** Retry once without --resume only for a quick, non-zero exit whose output says
 *  the session was unknown. */
export function shouldRetryWithoutResume(exitCode: number | undefined, tail: string | undefined, ageMs: number): boolean {
  return typeof exitCode === 'number' && exitCode !== 0 && ageMs >= 0 && ageMs < RESUME_RETRY_WINDOW_MS && isResumeFailure(tail);
}
