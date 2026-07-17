import { sql, type Kysely } from 'kysely';
import type { Selectable } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { toJson } from './infra/helpers';

// Column value types derived from the schema (Selectable unwraps the Generated<> wrappers), so this module
// needs no separate enum/type import.
type ImageRow = Selectable<DB['Image']>;
type MediaTypeValue = ImageRow['type'];
type ImageIngestionStatusValue = ImageRow['ingestion'];
type ImageTagRow = Selectable<DB['ImageTag']>;
type TagTypeValue = ImageTagRow['tagType'];
type TagSourceValue = ImageTagRow['source'];

export type PendingIngestionImage = {
  id: number;
  name: string | null;
  url: string;
  type: MediaTypeValue;
  createdAt: Date;
  metadata: unknown;
};

// Pending-ingestion queue window: images touched within the last 5 days.
const pendingCutoff = () => {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 5);
  return cutoff;
};

// Images stuck in 'Pending' ingestion within the last 5 days. Keyset-paginated on id desc. Read-only.
export async function getImagesPendingIngestion(
  db: Kysely<DB>,
  {
    cursor,
    limit,
  }: {
    cursor?: number;
    limit: number;
  }
): Promise<{ items: PendingIngestionImage[]; nextCursor?: number }> {
  const rows = (await db
    .selectFrom('Image')
    .select(['id', 'name', 'url', 'type', 'createdAt', 'metadata'])
    .where('ingestion', '=', 'Pending')
    .where('createdAt', '>', pendingCutoff())
    .$if(cursor != null, (qb) => qb.where('id', '<', cursor!))
    .orderBy('id', 'desc')
    .limit(limit + 1)
    .execute()) as PendingIngestionImage[];

  let nextCursor: number | undefined;
  if (rows.length > limit) nextCursor = rows.pop()?.id;
  return { items: rows, nextCursor };
}

// Total pending count for the page header (the queue's whole size, not just the current page).
export async function countImagesPendingIngestion(db: Kysely<DB>): Promise<number> {
  const row = await db
    .selectFrom('Image')
    .select((eb) => eb.fn.countAll<number>().as('count'))
    .where('ingestion', '=', 'Pending')
    .where('createdAt', '>', pendingCutoff())
    .executeTakeFirst();
  return Number(row?.count ?? 0);
}

export type IngestionErrorImage = {
  id: number;
  url: string;
  name: string | null;
  nsfwLevel: number;
  type: MediaTypeValue;
  width: number | null;
  height: number | null;
  createdAt: Date;
};

// Images that errored during ingestion and have no derived nsfwLevel yet — the review queue. Keyset cursor
// on id, newest first, within a 1h–2d age window. Raw SQL to preserve the INTERVAL window + enum cast.
export async function getIngestionErrorImages(
  db: Kysely<DB>,
  {
    limit,
    cursor,
  }: {
    limit: number;
    cursor?: number;
  }
): Promise<{ items: IngestionErrorImage[]; nextCursor?: number }> {
  const result = await sql<IngestionErrorImage>`
    SELECT i.id, i.url, i.name, i."nsfwLevel", i.type, i.width, i.height, i."createdAt"
    FROM "Image" i
    WHERE i."createdAt" > now() - INTERVAL '2 days'
      AND i."createdAt" < now() - INTERVAL '1 hour'
      AND i.ingestion = 'Error'::"ImageIngestionStatus"
      AND i."nsfwLevel" = 0
      AND (${cursor != null ? sql`i.id < ${cursor}` : sql`TRUE`})
    ORDER BY i."createdAt" DESC
    LIMIT ${limit + 1}
  `.execute(db);

  const items = result.rows;
  let nextCursor: number | undefined;
  if (items.length > limit) nextCursor = items.pop()?.id;

  return { items, nextCursor };
}

// The DB-update core of resolveIngestionError: pin the image's nsfwLevel, mark it Scanned, stamp the review
// reason into metadata (merged onto the existing jsonb, written back as a whole `::jsonb` object), then roll
// the change up to the post's nsfwLevel via the update_post_nsfw_levels DB function. Split out from the
// orchestration below so the write statements are independently reachable (the read-guard in
// resolveIngestionError can't return a row under the offline test driver). `postId`/`existingMetadata` are
// the fields resolveIngestionError reads before delegating here.
export async function applyIngestionErrorResolution(
  db: Kysely<DB>,
  {
    id,
    nsfwLevel,
    postId,
    existingMetadata,
  }: {
    id: number;
    nsfwLevel: number;
    postId: number | null;
    existingMetadata: unknown;
  }
): Promise<void> {
  const metadata = {
    ...((existingMetadata as Record<string, unknown> | null) ?? {}),
    nsfwLevelReason: 'Moderator ingestion error review',
  };

  await db
    .updateTable('Image')
    .set({
      nsfwLevel,
      nsfwLevelLocked: true,
      ingestion: 'Scanned',
      scannedAt: new Date(),
      metadata: toJson(metadata),
    })
    .where('id', '=', id)
    .execute();

  // Roll the change up to the post's nsfwLevel (DB function). Cast the bound array to int[] — Postgres infers
  // a bare `ARRAY[$1]` param array as text[], which wouldn't match the function's int[] signature.
  if (postId != null)
    await sql`SELECT update_post_nsfw_levels(ARRAY[${postId}]::int[])`.execute(db);
}

// Moderator resolves an ingestion error by pinning the image's nsfwLevel. Reads the current post/metadata,
// then applies the DB-update core. Side effects (search-index sync, mod-activity, cache busts) stay with the
// caller. `userId` is accepted for call-site parity but is not part of the DB core.
export async function resolveIngestionError(
  db: Kysely<DB>,
  {
    id,
    nsfwLevel,
  }: {
    id: number;
    nsfwLevel: number;
    userId: number;
  }
): Promise<void> {
  const image = await db
    .selectFrom('Image')
    .select(['postId', 'metadata'])
    .where('id', '=', id)
    .executeTakeFirst();
  if (!image) throw new Error('Image not found');

  await applyIngestionErrorResolution(db, {
    id,
    nsfwLevel,
    postId: image.postId,
    existingMetadata: image.metadata,
  });
}

// --- Ingestion status report for a set of image ids (getIngestionResults) ---

export type IngestionResultTag = {
  id: number;
  name: string;
  type: TagTypeValue;
  nsfwLevel: number;
  score: number;
  upVotes: number;
  downVotes: number;
  automated: boolean;
  needsReview: boolean;
  concrete: boolean;
  lastUpvote: Date | null;
  source: TagSourceValue;
  vote?: number;
};

export type IngestionResult = {
  ingestion: ImageIngestionStatusValue;
  blockedFor?: string;
  tags?: IngestionResultTag[];
};

// Per-image ingestion status plus votable tags, keyed by image id — the ingestion-results endpoint payload.
// A blocked image reports its `blockedFor` reason and no tags. Tags are the composite rows scoring > 0 or of
// the Moderation type, newest-scoring first; when `userId` is given, the caller's own votes are overlaid.
// Guards the empty id list. Pure read + shape — no cache.
export async function getIngestionResults(
  db: Kysely<DB>,
  { ids, userId }: { ids: number[]; userId?: number }
): Promise<Record<number, IngestionResult>> {
  if (!ids.length) return {};

  const images = await db
    .selectFrom('Image')
    .select(['id', 'ingestion', 'blockedFor'])
    .where('id', 'in', ids)
    .execute();

  const tagRows = await db
    .selectFrom('ImageTag')
    .select([
      'imageId',
      'tagId',
      'tagName',
      'tagType',
      'tagNsfwLevel',
      'score',
      'upVotes',
      'downVotes',
      'automated',
      'needsReview',
      'concrete',
      'lastUpvote',
      'source',
    ])
    .where('imageId', 'in', ids)
    .where((eb) => eb.or([eb('score', '>', 0), eb('tagType', '=', 'Moderation')]))
    .orderBy('score', 'desc')
    .execute();

  const tagsByImage = new Map<number, IngestionResultTag[]>();
  for (const row of tagRows) {
    const tag: IngestionResultTag = {
      id: row.tagId,
      name: row.tagName,
      type: row.tagType,
      nsfwLevel: row.tagNsfwLevel,
      score: row.score,
      upVotes: row.upVotes,
      downVotes: row.downVotes,
      automated: row.automated,
      needsReview: row.needsReview,
      concrete: row.concrete,
      lastUpvote: row.lastUpvote,
      source: row.source,
    };
    const list = tagsByImage.get(row.imageId);
    if (list) list.push(tag);
    else tagsByImage.set(row.imageId, [tag]);
  }

  const dictionary: Record<number, IngestionResult> = {};
  for (const image of images) {
    const blockedFor = image.blockedFor ?? undefined;
    dictionary[image.id] = {
      ingestion: image.ingestion,
      blockedFor,
      tags: blockedFor ? undefined : tagsByImage.get(image.id) ?? [],
    };
  }

  if (userId) {
    const votes = await db
      .selectFrom('TagsOnImageVote')
      .select(['tagId', 'vote'])
      .where('imageId', 'in', ids)
      .where('userId', '=', userId)
      .execute();
    const voteByTagId = new Map(votes.map((v) => [v.tagId, v.vote]));
    for (const key of Object.keys(dictionary)) {
      for (const tag of dictionary[Number(key)].tags ?? []) {
        const vote = voteByTagId.get(tag.id);
        if (vote !== undefined) tag.vote = vote > 0 ? 1 : -1;
      }
    }
  }

  return dictionary;
}
