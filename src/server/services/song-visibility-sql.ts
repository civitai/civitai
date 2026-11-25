import { Prisma } from '@prisma/client';

/**
 * Songs are `Image` rows with `type = 'audio'`. A generic image read serves them only to `music`
 * flag holders and moderators (`canSeeSongs`) and to their owner: this, as SQL over `"Image" i`, or
 * undefined when nothing is hidden. A leaf module, so readers outside the services (search indexes)
 * import no service graph with it.
 */
export function songsHiddenSql({ music, ownerId }: { music: boolean; ownerId?: number }) {
  if (music) return undefined;
  return ownerId
    ? Prisma.sql`(i."type" != 'audio' OR i."userId" = ${ownerId})`
    : Prisma.sql`i."type" != 'audio'`;
}
