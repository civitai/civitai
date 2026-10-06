import type { AugmentedPool } from '~/server/db/db-helpers';
import { isFlipt } from '~/server/flipt/client';
import { milestoneGrantableUserSql } from '~/server/services/creator-milestone-exclusions';
import { getFeatureFliptKey } from '~/server/services/feature-flags.service';

/**
 * Justin's decision (2026-10-06): while Creator Journey is behind its flag, tier badges are granted
 * only to users the flag is on for, and the launch backfill waits until the flag is public. Setting
 * this to false grants to everyone again; tier notifications stay flag-gated either way.
 */
export const CREATOR_JOURNEY_GRANTS_REQUIRE_FLAG = true;

const fliptKey = () => getFeatureFliptKey('creatorJourney') as string;

/**
 * The flag for a user who is not the session user. Moderators are on without asking Flipt, matching
 * the registry's `availability: ['mod']`. Everyone else is evaluated with only the properties the
 * `testers` segment matches on; a missing flag or an unreachable Flipt evaluates false, so this fails
 * closed for everyone but moderators.
 */
export async function isCreatorJourneyOnFor(user: { id: number; isModerator: boolean }) {
  if (user.isModerator) return true;
  return isFlipt(fliptKey(), String(user.id), {
    userId: String(user.id),
    isModerator: 'false',
  });
}

/** True only once the flag answers true for someone in no segment, i.e. it has gone public. */
export async function isCreatorJourneyPublic() {
  return isFlipt(fliptKey(), '0', { userId: '0', isModerator: 'false' });
}

/**
 * Of `userIds`, the users the flag is on for among those still owed a score tier they have reached.
 * Only they can produce a grant tonight, so nobody else is evaluated. Flipt evaluates in process, so
 * each check is a cached wasm call rather than a request.
 */
export async function creatorJourneyAudience(pg: AugmentedPool, userIds: number[]) {
  if (!userIds.length) return new Set<number>();
  const query = await pg.cancellableQuery<{ id: number; isModerator: boolean }>(
    `
    SELECT u.id, u."isModerator"
    FROM "User" u
    WHERE u.id = ANY($1::int[])
      AND ${milestoneGrantableUserSql('u')}
      AND EXISTS (
        SELECT 1 FROM "CreatorMilestone" m
        WHERE m.track = 'score' AND m.threshold IS NOT NULL
          AND (u.meta->'scores'->>'total')::numeric >= m.threshold
          AND NOT EXISTS (
            SELECT 1 FROM "UserCreatorMilestone" ucm
            WHERE ucm."userId" = u.id AND ucm."milestoneKey" = m.key
          )
      )
    `,
    [userIds]
  );
  const candidates = await query.result();
  const on = await Promise.all(candidates.map((user) => isCreatorJourneyOnFor(user)));
  return new Set(candidates.filter((_, i) => on[i]).map((user) => user.id));
}
