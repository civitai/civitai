import type { Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { imageUrl } from './image-url';
import { readWithoutJit } from '@civitai/db/knights';
import { servableImage } from './servable-image';

/** The moderator-curated collection the original game's rating guide drew its examples from. */
export const RATING_GUIDE_COLLECTION_ID = 10615797;

/** A database view of that collection's items; it is not in the generated schema. */
type RatingGuideView = {
  KnightsRatingGuideItem: {
    id: number;
    collectionId: number;
    imageId: number;
    status: string;
    createdAt: Date;
  };
};
export const EXAMPLES_PER_LEVEL = 8;
const EXAMPLE_WIDTH = 450;

export type RatingExample = {
  id: number;
  src: string;
  width: number | null;
  height: number | null;
};
export type RatingExamples = Record<number, RatingExample[]>;

type ExampleRow = {
  id: number;
  url: string;
  nsfwLevel: number;
  width: number | null;
  height: number | null;
};

/** Rows in collection order, grouped by the image's level, at most `EXAMPLES_PER_LEVEL` each. */
export function groupExamples(rows: ExampleRow[]): RatingExamples {
  const byLevel: RatingExamples = {};
  for (const row of rows) {
    const list = (byLevel[row.nsfwLevel] ??= []);
    if (list.length >= EXAMPLES_PER_LEVEL) continue;
    list.push({
      id: row.id,
      src: imageUrl(row.url, EXAMPLE_WIDTH),
      width: row.width,
      height: row.height,
    });
  }
  return byLevel;
}

const TTL_MS = 10 * 60_000;
const FAILURE_BACKOFF_MS = 60_000;
/** Past this since the last good read, failed reads show no examples rather than ones that may have stopped being servable. */
const STALE_AFTER_MS = 30 * 60_000;
let held: { at: number; examples: RatingExamples } | undefined;
let failedAt: number | undefined;

/**
 * Example images for each rating level. Held in this process for ten minutes and never throws: on a failed read the guide
 * shows the last examples read for up to 30 minutes after that read (none after), and the read is not retried for a minute.
 */
export async function ratingExamples(db: Kysely<DB>, now = Date.now()): Promise<RatingExamples> {
  if (held && now - held.at < TTL_MS) return held.examples;
  if (failedAt !== undefined && now - failedAt < FAILURE_BACKOFF_MS) return lastGood(now);
  try {
    const rows = await readWithoutJit(db, (trx) =>
      trx
        .withTables<RatingGuideView>()
        .selectFrom('KnightsRatingGuideItem as ci')
        .innerJoin('Image as img', 'img.id', 'ci.imageId')
        .innerJoin('Post as p', 'p.id', 'img.postId')
        .select(['img.id', 'img.url', 'img.nsfwLevel', 'img.width', 'img.height'])
        .where('ci.collectionId', '=', RATING_GUIDE_COLLECTION_ID)
        .where('ci.status', '=', 'ACCEPTED')
        .where(servableImage)
        .orderBy('ci.createdAt')
        .orderBy('ci.id')
        .execute()
    );
    const examples = groupExamples(rows);
    held = { at: now, examples };
    failedAt = undefined;
    return examples;
  } catch (error) {
    console.error('knights: could not read the rating guide examples', { error });
    failedAt = now;
    return lastGood(now);
  }
}

const lastGood = (now: number): RatingExamples =>
  held && now - held.at < STALE_AFTER_MS ? held.examples : {};

/** The rating guide with each level's examples attached (an empty list where there are none). */
export function withExamples<T extends { level: number }>(guide: T[], examples: RatingExamples) {
  return guide.map((entry) => ({ ...entry, examples: examples[entry.level] ?? [] }));
}
