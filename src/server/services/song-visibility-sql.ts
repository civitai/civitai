import { Prisma } from '@prisma/client';
import { getFeatureFlagsLazy } from '~/server/services/feature-flags.service';
import type { SessionUser } from '~/types/session';

/**
 * Whether generic image reads serve songs to `user`: the `music` flag, or a moderator (a Flipt answer
 * overrides the flag's role check, so a moderator outside its segment would otherwise lose them).
 */
export const canSeeSongs = (
  user: SessionUser | undefined,
  /** The caller's moderator view where it is narrower than the user's (`feedViewer`). */
  isModerator = !!user?.isModerator
) => isModerator || !!getFeatureFlagsLazy({ user }).music;

/**
 * Songs are `Image` rows with `type = 'audio'`. A generic image read serves them only to `music`
 * flag holders and moderators (`canSeeSongs`) and to their owner: this, as SQL over `"Image" i`, or
 * undefined when nothing is hidden. Kept out of image-visibility.service, so search indexes and
 * cover helpers import no service graph with it.
 */
export function songsHiddenSql({ music, ownerId }: { music: boolean; ownerId?: number }) {
  if (music) return undefined;
  return ownerId
    ? Prisma.sql`(i."type" != 'audio' OR i."userId" = ${ownerId})`
    : Prisma.sql`i."type" != 'audio'`;
}
