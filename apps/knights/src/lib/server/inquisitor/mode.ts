import { skillChecks } from '../skill-check/runtime';

/** The one definition of "plays as the Inquisitor": call this rather than re-deriving it, or `/play`, the header and `/home` drift apart. */
export async function isInquisitor(
  user: { isModerator?: boolean } | null | undefined
): Promise<boolean> {
  return user?.isModerator === true && (await skillChecks()).enabled;
}
