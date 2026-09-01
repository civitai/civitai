import { dbRead } from '~/server/db/client';
import type { HomeBlockMetaSchema } from '~/server/schema/home-block.schema';
import { autoFeatureSchema } from '~/server/schema/home-block.schema';
import { HomeBlockType } from '~/shared/utils/prisma/enums';

/**
 * Markers identifying a CollectionItem the auto-feature job added, rather than a curator.
 *
 * Their own module because both the job and the two collection-item removal paths need them,
 * and importing the service from collection.service.ts would pull the whole home-block graph in.
 */
export const AUTO_FEATURE_USERNAME = 'CivitaiOfficial';
export const AUTO_FEATURE_NOTE_PREFIX = 'auto-featured';
export const autoFeatureNote = (sourceCollectionId: number) =>
  `${AUTO_FEATURE_NOTE_PREFIX}:${sourceCollectionId}`;

/**
 * The `getJobDate` key `auto-feature-images` advances on. Shared so the health check watching that
 * timestamp cannot drift from the job that writes it — a mismatch would read as a permanently
 * silent job and page forever.
 *
 * 🔴 Do not normalise away the `job:` prefix. Every other `getJobDate` caller in the repo uses a
 * bare name, so this one looks like the odd one out and tidying it is the obvious edit — but the
 * key names a live row in the production `KeyValue` table. Renaming it orphans that row, and the
 * job then reads epoch 0, believes it has never run, and fires once immediately.
 * `auto-feature-health-check.test.ts` pins both sides against exactly this.
 */
export const AUTO_FEATURE_JOB_DATE_KEY = 'job:auto-feature-images';

/**
 * The default `intervalHours` re-exported from the schema rather than restated, so a health check
 * reasoning about the cadence of a job whose config has gone missing measures against the value
 * that job would actually have used.
 */
export const AUTO_FEATURE_DEFAULT_INTERVAL_HOURS = autoFeatureSchema.parse({
  collectionId: 1,
}).intervalHours;

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

/**
 * The system FeaturedCollections block and its parsed auto-feature config.
 *
 * 🔴 Here rather than in `auto-feature-images.service.ts` so the producer and the health check
 * watching it resolve the SAME block. There are four copies of this lookup in the repo and two of
 * them already disagree — `refresh-featured-collections-eligibility.ts` and `home-block.service.ts`
 * omit the `orderBy`, so if more than one system block ever exists they answer a different row.
 * A watcher measuring one block's `intervalHours` against another block's writes reports a fault
 * that does not exist, and the same argument the `getJobDate` key above makes applies here.
 *
 * It lives in this leaf module rather than being exported from the service on purpose: the health
 * check must not take a module-load dependency on the producer's graph, which reaches the home-block
 * cache and the eligibility job. Independence from the producer is the point of the check.
 *
 * Parsed rather than cast: hand-edited JSON, and every default the job relies on — perRun, the decay
 * constants, dryRun — exists only if the schema fills it in.
 */
export async function getAutoFeatureBlockConfig() {
  const block = await dbRead.homeBlock.findFirst({
    where: { userId: -1, type: HomeBlockType.FeaturedCollections },
    select: { id: true, metadata: true },
    orderBy: { id: 'asc' },
  });
  if (!block) return null;
  const metadata = (block.metadata || {}) as HomeBlockMetaSchema;
  const config = autoFeatureSchema.safeParse(metadata.featuredCollections?.autoFeature);
  if (!config.success) return null;
  return {
    blockId: block.id,
    config: config.data,
    pool: metadata.featuredCollections?.collectionIds ?? [],
  };
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
