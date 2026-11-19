import { sql, type Kysely } from 'kysely';
import { countOpenServableKnightItems } from '@civitai/db/knights';
import { utc } from '@civitai/db/kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { FEEDBACK_CAPTURE_OWNER_ID } from '@civitai/shared/feedback-capture';
import {
  KNIGHTS_NSFW_LEVEL_QUESTION,
  knightsSourcesMaxOpen,
  type KnightsSourcesConfig,
} from '@civitai/shared/new-order';
import { NsfwLevel } from '~/server/common/enums';
import {
  enqueueKnightsItems,
  type EnqueueOptions,
} from '~/server/services/knights/enqueue.service';
import { sfwBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';

export const KNIGHTS_SOURCE_SCAN_SAMPLE = 'scan-sample';

/**
 * Both samplers (a scan result, the publish sweep): only a live post, and an image is asked about at most once ever, so a
 * republished post or a rescan never queues it again.
 */
export const KNIGHTS_SAMPLE_ENQUEUE_OPTIONS: EnqueueOptions = {
  requirePost: true,
  requirePublished: true,
  oncePerImage: true,
};

/**
 * The image's fixed draw in [0, 1), compared with its pool's rate. Fixed per image, so a scan and a sweep (or two
 * overlapping sweeps) can't re-roll it; raising a rate admits images an earlier draw left out. murmur3's 32-bit finalizer.
 */
export function knightsSampleDraw(imageId: number): number {
  let h = imageId | 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4_294_967_296;
}

/** A post published this recently is left to the next run, so a publish whose transaction commits late is still seen. */
const SETTLE_MS = 60_000;
/** The furthest back a run looks, however long ago the last one ran (a fresh environment's last run reads as 1970). */
const MAX_LOOKBACK_MS = 6 * 3_600_000;
const POST_LIMIT = 200;
const ENQUEUE_CHUNK = 1000;

export type PublishSampleResult = {
  /** Where the next run starts: the window's end, or the last post read when the batch was full. */
  cursor: Date;
  posts: number;
  enqueued: number;
  /** Skipped for the intake cap (`maxOpen`), like a scan sample. */
  capped: boolean;
  /** A full batch shared one publish instant, so the run moved past posts it did not read. */
  skippedTies: boolean;
};

const epochMs = (value: string | number) => Math.round(Number(value) * 1000);

/**
 * Samples the still images of posts that went live in (`since`, `now` - 1 minute], at most `postLimit` posts, oldest
 * publish first. An image is a candidate once scanned and rated (not Blocked, not held); one not yet scanned is left to
 * the scan path, which samples it once its post is live. SFW and NSFW are split on `Image.nsfwLevel` the way the scan
 * splits them, and each image is drawn with `knightsSampleDraw` against its pool's rate. A run over the `maxOpen` cap
 * queues nothing and moves on, as a capped scan does.
 *
 * Republishing restores a post's earlier `publishedAt`, which lies outside the window, and its images that already had
 * an item are refused anyway (`oncePerImage`).
 */
export async function sampleNewlyLivePostsForKnights(
  db: Kysely<DB>,
  {
    since,
    now,
    config,
    postLimit = POST_LIMIT,
  }: { since: Date; now: Date; config: KnightsSourcesConfig; postLimit?: number }
): Promise<PublishSampleResult> {
  const upTo = new Date(now.getTime() - SETTLE_MS);
  const from = new Date(Math.max(since.getTime(), now.getTime() - MAX_LOOKBACK_MS));
  const result: PublishSampleResult = {
    cursor: new Date(Math.max(since.getTime(), upTo.getTime())),
    posts: 0,
    enqueued: 0,
    capped: false,
    skippedTies: false,
  };
  if (!config.enabled || from >= upTo) return result;

  // `Post_publishedAt_idx` range, bounded.
  const posts = await db
    .selectFrom('Post')
    .select(['id', sql<string>`extract(epoch from "publishedAt")`.as('publishedEpoch')])
    .where('publishedAt', '>', utc(from))
    .where('publishedAt', '<=', utc(upTo))
    .orderBy('publishedAt', 'asc')
    .orderBy('id', 'asc')
    .limit(postLimit)
    .execute();
  result.posts = posts.length;
  if (posts.length === 0) return result;
  if (posts.length === postLimit) {
    const first = epochMs(posts[0].publishedEpoch);
    const last = epochMs(posts[posts.length - 1].publishedEpoch);
    // The next run starts just before the last instant read, so posts sharing it past the limit are still seen; the
    // overlap re-reads a few, which `oncePerImage` keeps from queueing twice.
    result.skippedTies = first === last;
    result.cursor = new Date(first === last ? last : last - 1);
  }

  const images = await db
    .selectFrom('Image')
    .select(['id', 'nsfwLevel'])
    .where(
      'postId',
      'in',
      posts.map((p) => p.id)
    )
    .where('type', '=', 'image')
    .where('ingestion', '=', 'Scanned')
    .where('nsfwLevel', 'not in', [0, NsfwLevel.Blocked])
    .where('needsReview', 'is', null)
    .where('userId', '!=', FEEDBACK_CAPTURE_OWNER_ID)
    .orderBy('id', 'asc')
    .execute();

  const drawn = images
    .map(({ id, nsfwLevel }) => ({ imageId: id, nsfw: nsfwLevel > sfwBrowsingLevelsFlag }))
    .filter(
      ({ imageId, nsfw }) => knightsSampleDraw(imageId) < (nsfw ? config.nsfwRate : config.sfwRate)
    );
  if (drawn.length === 0) return result;

  const maxOpen = knightsSourcesMaxOpen(config);
  if ((await countOpenServableKnightItems(db, maxOpen + 1)) > maxOpen) {
    result.capped = true;
    return result;
  }

  for (let i = 0; i < drawn.length; i += ENQUEUE_CHUNK) {
    const outcomes = await enqueueKnightsItems(
      db,
      {
        source: KNIGHTS_SOURCE_SCAN_SAMPLE,
        questionKey: KNIGHTS_NSFW_LEVEL_QUESTION,
        items: drawn
          .slice(i, i + ENQUEUE_CHUNK)
          .map(({ imageId, nsfw }) => ({ imageId, priority: nsfw ? (2 as const) : (1 as const) })),
      },
      now,
      KNIGHTS_SAMPLE_ENQUEUE_OPTIONS
    );
    result.enqueued += outcomes.filter((o) => o.outcome === 'enqueued').length;
  }
  return result;
}
