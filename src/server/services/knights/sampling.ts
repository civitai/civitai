import { sql, type Kysely } from 'kysely';
import { countOpenServableKnightItems, servableImageContent } from '@civitai/db/knights';
import { utc } from '@civitai/db/kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { FEEDBACK_CAPTURE_OWNER_ID } from '@civitai/shared/feedback-capture';
import {
  KNIGHTS_NSFW_LEVEL_QUESTION,
  knightsSourcesMaxOpen,
  type KnightsSourcesConfig,
} from '@civitai/shared/new-order';
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
/**
 * Every run reads again the posts published this far behind its cursor: a scheduled publish stamps the scheduled time, and
 * an owner's publish stamps before it commits, so a post can land behind a cursor that has already passed it.
 */
const OVERLAP_MS = 15 * 60_000;
/** The furthest back a run looks, however long ago the last one ran. */
const MAX_LOOKBACK_MS = 6 * 3_600_000;
const POST_LIMIT = 200;
/** Posts re-read in the overlap per run, nearest the cursor first. */
const OVERLAP_POST_LIMIT = 2000;
const ENQUEUE_CHUNK = 1000;

/** The last post a run read, in publish order: `(publishedAt, id)`, so posts sharing one instant drain across runs. */
export type PublishSampleCursor = { publishedAt: Date; postId: number };

export type PublishSampleResult = {
  /** Where the next run starts: the last post read when the batch was full, else the window's end. */
  cursor: PublishSampleCursor;
  /** New posts read past the cursor (not counting the overlap re-read). */
  posts: number;
  enqueued: number;
  /** Stopped at the intake cap (`maxOpen`), like a scan sample. */
  capped: boolean;
};

const epochMs = (value: string | number) => Math.round(Number(value) * 1000);
const later = (a: Date, b: Date) => (a.getTime() >= b.getTime() ? a : b);

/**
 * Samples the still images of posts that went live after `cursor` and up to `now` - 1 minute, at most `postLimit` posts in
 * `(publishedAt, id)` order, plus the posts published in the 15 minutes behind the cursor, read again in case they landed
 * late. Never further back than 6 hours. An image is a candidate once scanned and `servableImageContent`; one not yet
 * scanned is left to the scan path, which samples it once its post is live. SFW and NSFW are split on `Image.nsfwLevel`
 * the way the scan splits them, and each image is drawn with `knightsSampleDraw` against its pool's rate. Images that
 * already had an item are dropped before the cap is counted, so re-reads cost no room; the run then queues at most as many
 * as keep the open count within `maxOpen`.
 *
 * Republishing restores a post's earlier `publishedAt`, usually outside the window, and its images that already had an
 * item are refused anyway (`oncePerImage`).
 */
export async function sampleNewlyLivePostsForKnights(
  db: Kysely<DB>,
  {
    cursor,
    now,
    config,
    postLimit = POST_LIMIT,
  }: {
    cursor: PublishSampleCursor | null;
    now: Date;
    config: KnightsSourcesConfig;
    postLimit?: number;
  }
): Promise<PublishSampleResult> {
  const upTo = new Date(now.getTime() - SETTLE_MS);
  const floor = new Date(now.getTime() - MAX_LOOKBACK_MS);
  const result: PublishSampleResult = {
    cursor:
      cursor && cursor.publishedAt.getTime() >= upTo.getTime()
        ? cursor
        : { publishedAt: upTo, postId: 0 },
    posts: 0,
    enqueued: 0,
    capped: false,
  };
  if (!config.enabled) return result;

  const start: PublishSampleCursor =
    cursor && cursor.publishedAt.getTime() > floor.getTime()
      ? cursor
      : { publishedAt: floor, postId: 0 };
  const startKey = sql`(${utc(start.publishedAt)}, ${start.postId}::int)`;

  // `Post_publishedAt_idx` ranges, both bounded.
  const fresh: { id: number; publishedEpoch: string }[] =
    start.publishedAt.getTime() >= upTo.getTime()
      ? []
      : await db
          .selectFrom('Post')
          .select(['id', sql<string>`extract(epoch from "publishedAt")`.as('publishedEpoch')])
          .where('publishedAt', '>=', utc(start.publishedAt))
          .where(sql<boolean>`("publishedAt", "id") > ${startKey}`)
          .where('publishedAt', '<=', utc(upTo))
          .orderBy('publishedAt', 'asc')
          .orderBy('id', 'asc')
          .limit(postLimit)
          .execute();
  const overlap = cursor
    ? await db
        .selectFrom('Post')
        .select('id')
        .where(
          'publishedAt',
          '>',
          utc(later(new Date(start.publishedAt.getTime() - OVERLAP_MS), floor))
        )
        .where(sql<boolean>`("publishedAt", "id") <= ${startKey}`)
        .orderBy('publishedAt', 'desc')
        .orderBy('id', 'desc')
        .limit(OVERLAP_POST_LIMIT)
        .execute()
    : [];

  result.posts = fresh.length;
  if (fresh.length === postLimit) {
    const last = fresh[fresh.length - 1];
    result.cursor = { publishedAt: new Date(epochMs(last.publishedEpoch)), postId: last.id };
  }
  const postIds = [...fresh, ...overlap].map((p) => p.id);
  if (postIds.length === 0) return result;

  const images = await db
    .selectFrom('Image as img')
    .innerJoin('Post as p', 'p.id', 'img.postId')
    .select(['img.id', 'img.nsfwLevel'])
    .where('img.postId', 'in', postIds)
    .where(servableImageContent)
    .where('img.ingestion', '=', 'Scanned')
    .where('img.userId', '!=', FEEDBACK_CAPTURE_OWNER_ID)
    .orderBy('img.id', 'asc')
    .execute();

  const drawn = images
    .map(({ id, nsfwLevel }) => ({ imageId: id, nsfw: nsfwLevel > sfwBrowsingLevelsFlag }))
    .filter(
      ({ imageId, nsfw }) => knightsSampleDraw(imageId) < (nsfw ? config.nsfwRate : config.sfwRate)
    );
  if (drawn.length === 0) return result;

  // `KnightsQueueItem_imageId_idx`: the overlap re-reads mostly images already asked about.
  const asked = new Set(
    (
      await db
        .selectFrom('KnightsQueueItem')
        .select('imageId')
        .where('questionKey', '=', KNIGHTS_NSFW_LEVEL_QUESTION)
        .where('isHiddenCheck', '=', false)
        .where(
          'imageId',
          'in',
          drawn.map((d) => d.imageId)
        )
        .execute()
    ).map((row) => row.imageId)
  );
  const todo = drawn.filter((d) => !asked.has(d.imageId));
  if (todo.length === 0) return result;

  const maxOpen = knightsSourcesMaxOpen(config);
  const room = Math.max(0, maxOpen - (await countOpenServableKnightItems(db, maxOpen + 1)));
  result.capped = todo.length > room;
  const admitted = todo.slice(0, room);

  for (let i = 0; i < admitted.length; i += ENQUEUE_CHUNK) {
    const outcomes = await enqueueKnightsItems(
      db,
      {
        source: KNIGHTS_SOURCE_SCAN_SAMPLE,
        questionKey: KNIGHTS_NSFW_LEVEL_QUESTION,
        items: admitted
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

/**
 * One run of the publish sweep: reads the sources switch and the stored cursor, samples, and stores the new cursor. A
 * switch that could not be read (`readConfig` gives null) leaves the cursor where it was, so the next run retries the
 * window; a switch that is off still moves it on.
 */
export async function runKnightsPublishSampling(
  db: Kysely<DB>,
  {
    now,
    readConfig,
    loadCursor,
    saveCursor,
  }: {
    now: Date;
    readConfig: () => Promise<KnightsSourcesConfig | null>;
    loadCursor: () => Promise<PublishSampleCursor | null>;
    saveCursor: (cursor: PublishSampleCursor) => Promise<void>;
  }
): Promise<PublishSampleResult | { skipped: 'config-unreadable' }> {
  const config = await readConfig();
  if (!config) return { skipped: 'config-unreadable' };
  const result = await sampleNewlyLivePostsForKnights(db, {
    cursor: await loadCursor(),
    now,
    config,
  });
  await saveCursor(result.cursor);
  return result;
}
