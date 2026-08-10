import { sql } from '@civitai/db/kysely';
import { dbRead } from './db';
import { getModeratorDb } from './moderator-db';
import type { MediaType } from '$lib/media/edge-url';

// Retool's Moderation Status "help requests": a moderator asking colleagues for a second opinion on a
// set of images. `ModerationImageHelp` lives in the moderator database and its `imageIds` is a jsonb
// array; the images themselves come from the main database.

export type HelpRequest = {
  id: number;
  createdBy: string | null;
  type: string | null;
  createdAt: Date;
  imageIds: number[];
};

export type HelpImage = {
  id: number;
  url: string;
  name: string | null;
  type: MediaType;
  nsfwLevel: number;
  needsReview: string | null;
  blockedFor: string | null;
  ingestion: string;
};

// `imageIds` is jsonb and has held both bare ids and objects over the table's life, so anything that is
// not a positive int4 is dropped rather than trusted into a query.
const MAX_INT4 = 2_147_483_647;
function parseImageIds(value: unknown): number[] {
  const raw = Array.isArray(value) ? value : [];
  const ids = raw.map((v) =>
    typeof v === 'number'
      ? v
      : typeof v === 'object' && v
      ? Number((v as { id?: unknown }).id)
      : NaN
  );
  return [...new Set(ids.filter((n) => Number.isInteger(n) && n > 0 && n <= MAX_INT4))];
}

export async function getOpenHelpRequests(): Promise<HelpRequest[]> {
  const rows = await getModeratorDb()
    .selectFrom('ModerationImageHelp')
    .select(['id', 'createdBy', 'type', 'createdAt', 'imageIds'])
    .where('isHandled', '=', false)
    .orderBy('createdAt', 'asc')
    .execute();

  return rows.map((r) => ({
    id: r.id,
    createdBy: r.createdBy,
    type: r.type,
    createdAt: new Date(r.createdAt),
    imageIds: parseImageIds(r.imageIds),
  }));
}

/**
 * The images behind ONE request, resolved from the stored row rather than from anything the client
 * sent. Retool passed the id array through the browser, so a stale page could act on a different set
 * than the request describes.
 */
export async function getHelpRequestImages(requestId: number): Promise<HelpImage[]> {
  const row = await getModeratorDb()
    .selectFrom('ModerationImageHelp')
    .select('imageIds')
    .where('id', '=', requestId)
    .executeTakeFirst();

  const ids = parseImageIds(row?.imageIds);
  if (!ids.length) return [];

  return dbRead
    .selectFrom('Image')
    .select(['id', 'url', 'name', 'type', 'nsfwLevel', 'needsReview', 'blockedFor', 'ingestion'])
    .where('id', 'in', ids)
    .orderBy('id', 'desc')
    .execute() as Promise<HelpImage[]>;
}

// PRODUCERS (Retool's GetMinors/GetPoI/GetReported → StoreMinors/StorePoI/StoreReported).
//
// Without these the page is a consumer with no producer: it drains rows Retool created and, once Retool
// is switched off, empties permanently. Moving the moderator database does not fix that — the data
// moves, the producer does not.
//
// In Retool each was a button whose success handler filed the batch it had just selected. Same shape
// here, in one action, because the two halves were never independently useful.
export const HELP_TYPES = ['minor', 'poi', 'reported'] as const;
export type HelpType = (typeof HELP_TYPES)[number];

// Retool filed the whole backlog. `imageIds` is a jsonb array read back in full on every page load, so
// an unbounded file-everything writes a row nothing can render. The cap is disclosed to the caller
// rather than silently applied — a request that covers 500 of 4,000 must not read as covering all of them.
const HELP_BATCH_CAP = 500;

async function getHelpCandidates(type: HelpType): Promise<number[]> {
  if (type === 'reported') {
    const rows = await dbRead
      .selectFrom('ImageReport as ir')
      .innerJoin('Report as r', 'r.id', 'ir.reportId')
      .select('ir.imageId as id')
      .where('r.status', '=', 'Pending')
      .orderBy('ir.imageId', 'desc')
      .limit(HELP_BATCH_CAP + 1)
      .execute();
    return [...new Set(rows.map((r) => r.id))];
  }

  const rows = await dbRead
    .selectFrom('Image')
    .select('id')
    .where('needsReview', '=', type)
    .where('ingestion', 'is not', null)
    .orderBy('id', 'desc')
    .limit(HELP_BATCH_CAP + 1)
    .execute();
  return rows.map((r) => r.id);
}

export async function createHelpRequest(input: {
  type: HelpType;
  createdBy: string;
}): Promise<{ ok: boolean; count: number; truncated: boolean; error?: string }> {
  const found = await getHelpCandidates(input.type);
  const truncated = found.length > HELP_BATCH_CAP;
  const imageIds = found.slice(0, HELP_BATCH_CAP);

  // Filing an empty request puts a row in the queue that renders as an empty grid and can only be
  // resolved by hand.
  if (!imageIds.length)
    return { ok: false, count: 0, truncated: false, error: 'Nothing is waiting for this type.' };

  await getModeratorDb()
    .insertInto('ModerationImageHelp')
    .values({
      createdBy: input.createdBy,
      type: input.type,
      // The column is jsonb; the driver would otherwise send a Postgres int array.
      imageIds: JSON.stringify(imageIds),
      isHandled: false,
    })
    .execute();

  return { ok: true, count: imageIds.length, truncated };
}

/**
 * Retool's `UpdateHelpRequest`. `handledBy` is TEXT holding a moderator NAME, not an id — a quirk of
 * the Retool schema preserved deliberately so the column keeps meaning the same thing until these
 * tables move off it.
 */
export async function resolveHelpRequest(input: {
  requestId: number;
  handledBy: string;
}): Promise<{ ok: boolean }> {
  const result = await getModeratorDb()
    .updateTable('ModerationImageHelp')
    .set({ isHandled: true, handledBy: input.handledBy, handledAt: sql`now()` })
    .where('id', '=', input.requestId)
    .where('isHandled', '=', false)
    .executeTakeFirst();

  // Scoped on `isHandled = false`, so zero rows means someone else already took it — not success.
  return { ok: Number(result.numUpdatedRows ?? 0) > 0 };
}
