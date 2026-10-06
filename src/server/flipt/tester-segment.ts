import { isFlipt } from '~/server/flipt/client';

/**
 * A moderators-plus-testers flag for a user who is not the session user, known only by
 * `{ id, isModerator }`. Moderators are on without asking Flipt. Everyone else is evaluated with only
 * the two properties the `testers` segment matches on: `buildFliptContext` would invent tier and
 * cohort values this caller never knew, letting a tier- or cohort-scoped rollout match on them.
 *
 * Unlike the session registry, a moderator stays on even if Flipt answers false for them, so a flag
 * meant for this helper must roll out to moderators.
 */
export async function isFliptOnForTesters(
  flag: string,
  user: { id?: number; isModerator?: boolean }
): Promise<boolean> {
  if (user.isModerator) return true;
  if (!user.id) return false;
  return isFlipt(flag, String(user.id), { userId: String(user.id), isModerator: 'false' });
}
