import { sql, type Kysely } from 'kysely';
import { servableImage } from '@civitai/db/knights';
import { utc } from '@civitai/db/kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { KNIGHTS_STAGE_RANKS, KNIGHTS_STAGE_TTL_HOURS } from '@civitai/shared/new-order';

export type EnqueueItemInput = {
  imageId: number;
  priority: 1 | 2 | 3;
  minRank?: string;
  votesNeeded?: number;
  /** Omit for one stage from now; `null` for never. */
  expiresAt?: Date | null;
  prediction?: unknown;
};

export type EnqueueInput = {
  source: string;
  questionKey: string;
  items: EnqueueItemInput[];
};

export type EnqueueRefusal =
  | 'unknown-question'
  | 'inactive-question'
  | 'bad-priority'
  | 'bad-rank'
  | 'bad-votes'
  | 'bad-expiry'
  | 'image-not-found'
  | 'held-for-review'
  | 'not-servable'
  | 'not-still-image'
  | 'no-post'
  | 'unpublished';

export type EnqueueOptions = {
  /**
   * Refuse images the public feeds would not show. Intake leaves it off: scan results often
   * arrive before the post is published.
   */
  servableOnly?: boolean;
  /**
   * Refuse images with no post (`no-post`) or whose post is not live at `now`: a draft or a later
   * date (`unpublished`). Scan sampling and owner ratings pass it; the publish sweep samples the
   * post once it goes live.
   */
  requirePublished?: boolean;
  /**
   * Treat an image that ever had an item for the question, in any status, as a `duplicate`, not
   * only one still open. Hidden-check copies do not count. Sampling passes it, so an image is
   * sampled at most once however often it is scanned or published.
   */
  oncePerImage?: boolean;
  /** Refuse anything but a still image (`not-still-image`): Knights serves only those. Owner ratings pass it. */
  stillImagesOnly?: boolean;
};

export type EnqueueOutcome = { imageId: number } & (
  | { outcome: 'enqueued'; itemId: number }
  | { outcome: 'duplicate' }
  | { outcome: 'refused'; reason: EnqueueRefusal }
);

const isStageRank = (rank: string) => (KNIGHTS_STAGE_RANKS as readonly string[]).includes(rank);

type Planned = {
  imageId: number;
  minRank: string;
  votesNeeded: number;
  priority: number;
  expiresAt: Date | null;
  prediction: string | null;
};

export async function enqueueKnightsItems(
  db: Kysely<DB>,
  input: EnqueueInput,
  now: Date = new Date(),
  {
    servableOnly = false,
    requirePublished = false,
    oncePerImage = false,
    stillImagesOnly = false,
  }: EnqueueOptions = {}
): Promise<EnqueueOutcome[]> {
  const refuseAll = (reason: EnqueueRefusal): EnqueueOutcome[] =>
    input.items.map((item) => ({ imageId: item.imageId, outcome: 'refused', reason }));

  const question = await db
    .selectFrom('KnightsQuestion')
    .select(['active', 'minRank', 'votesToResolve'])
    .where('key', '=', input.questionKey)
    .executeTakeFirst();
  if (!question) return refuseAll('unknown-question');
  if (!question.active) return refuseAll('inactive-question');

  const images = new Map<
    number,
    {
      held: boolean;
      still: boolean;
      servable: boolean;
      hasPost: boolean;
      publishesAt: Date | null;
    }
  >(
    input.items.length === 0
      ? []
      : (
          await db
            .selectFrom('Image as img')
            .leftJoin('Post as p', 'p.id', 'img.postId')
            .select((eb) => [
              'img.id',
              'img.needsReview',
              'img.acceptableMinor',
              'img.type',
              'p.id as postRowId',
              // Epoch seconds of the UTC timestamp, so the comparison does not depend on how the driver parses it.
              sql<string | null>`extract(epoch from ${eb.ref('p.publishedAt')})`.as(
                'publishedEpoch'
              ),
              servableImage(eb).as('servable'),
            ])
            .where('img.id', 'in', [...new Set(input.items.map((i) => i.imageId))])
            .execute()
        ).map((row) => [
          row.id,
          {
            held: row.needsReview !== null || row.acceptableMinor,
            still: row.type === 'image',
            servable: Boolean(row.servable),
            hasPost: row.postRowId !== null,
            publishesAt:
              row.publishedEpoch === null ? null : new Date(Number(row.publishedEpoch) * 1000),
          },
        ])
  );

  const outcomes: (EnqueueOutcome | null)[] = [];
  const planned: Planned[] = [];
  const plannedIndex = new Map<number, number>();
  const seen = new Set<number>();

  input.items.forEach((item, index) => {
    const refuse = (reason: EnqueueRefusal) => {
      outcomes[index] = { imageId: item.imageId, outcome: 'refused', reason };
    };
    const minRank = item.minRank ?? question.minRank;
    const votesNeeded = item.votesNeeded ?? question.votesToResolve;

    if (![1, 2, 3].includes(item.priority)) return refuse('bad-priority');
    if (!isStageRank(minRank)) return refuse('bad-rank');
    if (!Number.isInteger(votesNeeded) || votesNeeded < 1) return refuse('bad-votes');
    const expiresAt =
      item.expiresAt === undefined
        ? new Date(now.getTime() + KNIGHTS_STAGE_TTL_HOURS * 3_600_000)
        : item.expiresAt;
    if (expiresAt && expiresAt.getTime() <= now.getTime()) return refuse('bad-expiry');
    const image = images.get(item.imageId);
    if (image === undefined) return refuse('image-not-found');
    if (image.held) return refuse('held-for-review');
    if (stillImagesOnly && !image.still) return refuse('not-still-image');
    if (servableOnly && !image.servable) return refuse('not-servable');
    if (requirePublished && !image.hasPost) return refuse('no-post');
    if (
      requirePublished &&
      (image.publishesAt === null || image.publishesAt.getTime() > now.getTime())
    )
      return refuse('unpublished');
    if (seen.has(item.imageId)) {
      outcomes[index] = { imageId: item.imageId, outcome: 'duplicate' };
      return;
    }
    seen.add(item.imageId);

    plannedIndex.set(item.imageId, index);
    outcomes[index] = null;
    planned.push({
      imageId: item.imageId,
      minRank,
      votesNeeded,
      priority: item.priority,
      expiresAt,
      prediction: item.prediction === undefined ? null : JSON.stringify(item.prediction),
    });
  });

  if (planned.length > 0) {
    const stamp = utc(now);
    const inserted = await sql<{ id: number; imageId: number }>`
      INSERT INTO "KnightsQueueItem"
        ("questionKey", "imageId", "source", "minRank", "votesNeeded", "priority", "expiresAt", "prediction", "createdAt", "updatedAt")
      SELECT ${input.questionKey}, v."imageId", ${
      input.source
    }, v."minRank", v."votesNeeded", v."priority",
             v."expiresAt"::timestamp, v."prediction"::jsonb, ${stamp}, ${stamp}
      FROM unnest(
        ${planned.map((p) => p.imageId)}::int[],
        ${planned.map((p) => p.minRank)}::text[],
        ${planned.map((p) => p.votesNeeded)}::int[],
        ${planned.map((p) => p.priority)}::int[],
        ${planned.map((p) => p.expiresAt?.toISOString() ?? null)}::text[],
        ${planned.map((p) => p.prediction)}::text[]
      ) AS v("imageId", "minRank", "votesNeeded", "priority", "expiresAt", "prediction")
      WHERE NOT EXISTS (
        SELECT 1 FROM "KnightsQueueItem" e
        WHERE e."questionKey" = ${input.questionKey}
          AND e."imageId" = v."imageId"
          AND (${sql.lit(oncePerImage)} OR e."status" IN ('Open', 'Inquisitor', 'Ruling'))
          AND NOT e."isHiddenCheck"
      )
      ON CONFLICT DO NOTHING
      RETURNING "id", "imageId"
    `.execute(db);

    const created = new Map(inserted.rows.map((row) => [row.imageId, row.id]));
    for (const [imageId, index] of plannedIndex) {
      const itemId = created.get(imageId);
      outcomes[index] =
        itemId === undefined
          ? { imageId, outcome: 'duplicate' }
          : { imageId, outcome: 'enqueued', itemId };
    }
  }

  return outcomes as EnqueueOutcome[];
}
