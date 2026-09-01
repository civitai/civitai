import { dbRead } from '~/server/db/client';

/**
 * Markers identifying a CollectionItem the auto-feature job added, rather than a curator.
 *
 * Their own module because both the job and the two collection-item removal paths need them,
 * and importing the service from collection.service.ts would pull the whole home-block graph in.
 */
/**
 * The `getJobDate` key `auto-feature-images` advances on. Shared so the health check watching that
 * timestamp cannot drift from the job that writes it — a mismatch would read as a permanently
 * silent job and page forever.
 */
export const AUTO_FEATURE_JOB_DATE_KEY = 'job:auto-feature-images';

export const AUTO_FEATURE_USERNAME = 'CivitaiOfficial';
export const AUTO_FEATURE_NOTE_PREFIX = 'auto-featured';
export const autoFeatureNote = (sourceCollectionId: number) =>
  `${AUTO_FEATURE_NOTE_PREFIX}:${sourceCollectionId}`;

/**
 * Resolved by username so the same code identifies the right account in dev, preview and prod
 * rather than depending on one database's ids. Null when the account doesn't exist, which reads
 * as "no row is auto-featured" — removal then behaves exactly as it did before this feature, and
 * the job refuses to write anything it couldn't attribute.
 *
 * Uncached on purpose: `User_username_key` makes this 0.03 ms, and every caller is a user action
 * or a six-hourly job rather than a loop.
 */
export async function getAutoFeatureUserId() {
  const user = await dbRead.user.findFirst({
    where: { username: AUTO_FEATURE_USERNAME },
    select: { id: true },
  });
  return user?.id ?? null;
}

export function isAutoFeaturedRow(
  row: { addedById?: number | null; note?: string | null },
  autoFeatureUserId: number | null
) {
  if (autoFeatureUserId === null) return false;
  return (
    row.addedById === autoFeatureUserId && !!row.note?.startsWith(`${AUTO_FEATURE_NOTE_PREFIX}:`)
  );
}
