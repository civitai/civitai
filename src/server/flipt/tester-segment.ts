import { ensureFliptInitialized, getFliptClientSync, isFlipt } from '~/server/flipt/client';

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

/**
 * True once the flag answers true for someone in no segment, i.e. its base is on. A percentage
 * rollout could put entity '0' in its bucket early, so launch by setting `enabled`.
 */
export function isFliptPublic(flag: string) {
  return isFlipt(flag, '0', { userId: '0', isModerator: 'false' });
}

/**
 * Whether a "no" from this flag is a real answer. Every evaluation fails closed to false until the
 * Flipt client has initialised (after which it keeps evaluating from its last config even if Flipt
 * goes away), and `isFlipt` also turns an evaluation error, such as the flag missing from that
 * config, into false. So the client must exist and the flag must evaluate without throwing.
 */
export async function isFliptFlagReadable(flag: string) {
  await ensureFliptInitialized();
  const client = getFliptClientSync();
  if (!client) return false;
  try {
    client.evaluateBoolean({
      flagKey: flag,
      entityId: '0',
      context: { userId: '0', isModerator: 'false' },
    });
    return true;
  } catch {
    return false;
  }
}
