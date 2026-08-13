import { sql } from '@civitai/db/kysely';
import { dbRead } from './db';
import { usersByIds } from './users.service';
import type { MediaType } from '../media/edge-url';

// The PAGE LOAD half of Image Lookup (Retool's "Image Lookup" app). Everything here is Postgres and
// sub-millisecond on the indexes, so it all rides the load; the ClickHouse half lives in
// image-signals.service.ts behind `/api/image-signals`. One file per endpoint — see
// user-lookup.service.ts for the same split.

export type ImageDetail = {
  id: number;
  url: string;
  name: string | null;
  createdAt: Date;
  /** Last write of ANY kind, moderation included — so it dates the last action on a row whose own
   *  history is not otherwise visible here. */
  updatedAt: Date | null;
  userId: number;
  username: string | null;
  userBannedAt: Date | null;
  postId: number | null;
  type: MediaType;
  width: number | null;
  height: number | null;
  nsfwLevel: number;
  nsfwLevelLocked: boolean;
  tosViolation: boolean;
  needsReview: string | null;
  ingestion: string;
  blockedFor: string | null;
  minor: boolean;
  poi: boolean;
  acceptableMinor: boolean;
  scannedAt: Date | null;
  hideMeta: boolean;
  hash: string | null;
  pHash: string | null;
  scanJobs: unknown;
  prompt: string | null;
  negativePrompt: string | null;
};

export type ImageTag = {
  id: number;
  name: string;
  nsfwLevel: number;
  isCategory: boolean;
  automated: boolean;
  confidence: number | null;
  disabled: boolean;
  needsReview: boolean;
  source: string | null;
};

/** Tags the scanner assigned but did not apply — why an image was flagged without being visibly tagged. */
export type ShadowTag = { id: number; name: string; confidence: number | null };

export type ImageReactionRow = {
  key: string;
  userId: number;
  username: string | null;
  bannedAt: Date | null;
  reaction: string;
  createdAt: Date;
  /** Differs from `createdAt` when the reaction was changed rather than first given. */
  updatedAt: Date | null;
};

export type ImageReportRow = {
  id: number;
  reason: string;
  status: string;
  createdAt: Date;
  details: unknown;
  reportedById: number;
  reportedBy: string | null;
  internalNotes: string | null;
  alsoReportedBy: number[] | null;
  previouslyReviewedCount: number | null;
  statusSetAt: Date | null;
  statusSetById: number | null;
  statusSetBy: string | null;
};

export type ImageModActivity = {
  id: number;
  activity: string;
  createdAt: Date;
  moderatorId: number | null;
  moderatorUsername: string | null;
};

export type ImageLookupResult = {
  image: ImageDetail;
  tags: ImageTag[];
  shadowTags: ShadowTag[];
  reactions: { rows: ImageReactionRow[]; truncated: boolean };
  reports: ImageReportRow[];
  modActivity: { rows: ImageModActivity[]; truncated: boolean };
};

// Retool had two inputs and two queries — an id box and a separate url box (`GetIdFromUrl`). One
// resolver instead, matching the User Lookup shell: a moderator pasting from the CDN has a URL, one
// working from a report has an id, and neither should have to know which box to use.
//
// Four shapes reach this box, and three of them are URLs:
//   138809682                                                   → id
//   https://civitai.com/images/138809682                        → id in the LAST segment
//   https://image.civitai.com/<hash>/<uuid>/original=true/x.jpeg → `Image.url` is the SECOND segment,
//                                                                 NOT the last (that is a filename)
//   5565c259-95e6-4c89-898e-993eabf8ef88                        → bare `Image.url`
// Taking the last segment of a CDN link yields `<uuid>.jpeg`, which never matches the stored bare uuid —
// so every pasted CDN URL, the case this exists for, silently returned "no image matches". The main app
// documents the same rule in `utils/article-helpers.ts`.
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

// `Image.id` is a Postgres `integer`; anything larger errors the query instead of missing, which turned a
// double-pasted id into a 500 rather than "no image matches".
const MAX_INT = 2_147_483_647;
const asId = (value: string) => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n <= MAX_INT ? n : null;
};

export async function resolveImageId(term: string): Promise<number | null> {
  const value = term.trim();
  if (!value) return null;

  if (/^\d+$/.test(value)) return asId(value);

  const uuid = value.match(UUID)?.[0];
  if (!uuid) {
    // A site URL (`/images/138809682`) has the id as its last segment.
    const last = value.split(/[?#]/)[0].replace(/\/+$/, '').split('/').pop() ?? '';
    if (/^\d+$/.test(last)) return asId(last);
  }

  // Retool matched `url` against the raw term, so any stored value resolved. Older rows hold full
  // CDN URLs rather than a bare UUID; without the fallback those report "no image matches", which
  // reads as deleted rather than as an unrecognised format.
  const row = await dbRead
    .selectFrom('Image')
    .select('id')
    .where('url', '=', uuid ?? value)
    .executeTakeFirst();
  return row?.id ?? null;
}

export async function getImageLookup(imageId: number): Promise<ImageLookupResult | null> {
  const image = await getImage(imageId);
  if (!image) return null;

  const [tags, shadowTags, reactions, reports, modActivity] = await Promise.all([
    getTags(imageId),
    getShadowTags(imageId),
    getReactions(imageId),
    getReports(imageId),
    getModActivity(imageId),
  ]);
  return { image, tags, shadowTags, reactions, reports, modActivity };
}

async function getImage(imageId: number): Promise<ImageDetail | null> {
  const row = await dbRead
    .selectFrom('Image as i')
    .leftJoin('User as u', 'u.id', 'i.userId')
    .select([
      'i.id',
      'i.url',
      'i.name',
      'i.createdAt',
      'i.updatedAt',
      'i.userId',
      'i.postId',
      'i.type',
      'i.width',
      'i.height',
      'i.nsfwLevel',
      'i.nsfwLevelLocked',
      'i.tosViolation',
      'i.needsReview',
      'i.ingestion',
      'i.blockedFor',
      'i.minor',
      'i.poi',
      'i.acceptableMinor',
      'i.scannedAt',
      'i.hideMeta',
      'i.hash',
      'i.pHash',
      'i.scanJobs',
      'u.username',
      'u.bannedAt as userBannedAt',
      // Retool's Image Data table was a `SELECT *` — "expose all the columns… the hashes or the meta".
      // `meta` holds the generation prompt, which is the evidence behind a minor/poi call.
      sql<string | null>`i."meta" ->> 'prompt'`.as('prompt'),
      sql<string | null>`i."meta" ->> 'negativePrompt'`.as('negativePrompt'),
    ])
    .where('i.id', '=', imageId)
    .executeTakeFirst();
  if (!row) return null;

  // The column is Prisma's MediaType enum; narrowing here keeps EdgeMedia's contract honest rather than
  // widening it to string at the boundary.
  return { ...row, type: row.type as MediaType, ingestion: String(row.ingestion) };
}

// `TagsOnImageDetails` is a VIEW over the tag tables; `disabled`/`needsReview` are what a moderator is
// looking for, since a disabled tag is one a moderator or the scanner already overrode.
async function getTags(imageId: number): Promise<ImageTag[]> {
  const rows = await dbRead
    .selectFrom('TagsOnImageDetails as toi')
    .innerJoin('Tag as t', 't.id', 'toi.tagId')
    .select([
      't.id',
      't.name',
      't.nsfwLevel',
      't.isCategory',
      'toi.automated',
      'toi.confidence',
      'toi.disabled',
      'toi.needsReview',
      'toi.source',
    ])
    .where('toi.imageId', '=', imageId)
    .orderBy('t.name')
    .execute();
  return rows.map((r) => ({ ...r, source: r.source === null ? null : String(r.source) }));
}

async function getShadowTags(imageId: number): Promise<ShadowTag[]> {
  return dbRead
    .selectFrom('ShadowTagsOnImage as stoi')
    .innerJoin('Tag as t', 't.id', 'stoi.tagId')
    .select(['t.id', 't.name', 'stoi.confidence'])
    .where('stoi.imageId', '=', imageId)
    .orderBy('stoi.confidence', 'desc')
    .execute();
}

// Retool listed every reaction row. Capped here: a popular image carries thousands, and the question a
// moderator asks of this list ("who reacted, and are they connected?") is answered by the IP clustering
// in the signals panel rather than by an exhaustive list.
async function getReactions(
  imageId: number,
  limit = 100
): Promise<{ rows: ImageReactionRow[]; truncated: boolean }> {
  const rows = await dbRead
    .selectFrom('ImageReaction as ir')
    .leftJoin('User as u', 'u.id', 'ir.userId')
    .select([
      'ir.id',
      'ir.userId',
      'ir.reaction',
      'ir.createdAt',
      'ir.updatedAt',
      'u.username',
      'u.bannedAt',
    ])
    .where('ir.imageId', '=', imageId)
    .orderBy('ir.createdAt', 'desc')
    .limit(limit + 1)
    .execute();

  const truncated = rows.length > limit;
  const page = rows.slice(0, limit).map((r) => ({
    // `ImageReaction` is unique on (imageId, userId, reaction), so one user appears once per reaction
    // type — the row id is the only single-column key that holds.
    key: String(r.id),
    userId: r.userId,
    username: r.username,
    bannedAt: r.bannedAt,
    reaction: String(r.reaction),
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }));

  return { rows: page, truncated };
}

async function getReports(imageId: number): Promise<ImageReportRow[]> {
  const rows = await dbRead
    .selectFrom('ImageReport as ir')
    .innerJoin('Report as r', 'r.id', 'ir.reportId')
    .select([
      'r.id',
      'r.reason',
      'r.status',
      'r.createdAt',
      'r.details',
      'r.userId as reportedById',
      // Retool's report table showed all of these. 'One report' and 'thirty reports' are the whole
      // triage signal, and who cleared it is how a moderator knows whether to re-open it.
      'r.internalNotes',
      'r.alsoReportedBy',
      'r.previouslyReviewedCount',
      'r.statusSetAt',
      'r.statusSetBy as statusSetById',
    ])
    .where('ir.imageId', '=', imageId)
    .orderBy('r.createdAt', 'desc')
    .execute();

  const byId = await usersByIds([
    ...rows.map((r) => r.reportedById),
    ...rows.map((r) => r.statusSetById ?? 0),
  ]);
  return rows.map((r) => ({
    ...r,
    reason: String(r.reason),
    status: String(r.status),
    reportedBy: byId.get(r.reportedById)?.username ?? null,
    statusSetBy: r.statusSetById ? byId.get(r.statusSetById)?.username ?? null : null,
  }));
}

// Retool ran `SELECT * FROM "ModActivity" WHERE "entityId" = <id>` with NO entityType. That is wrong,
// not just slow: entity ids are per-type, so an image id collides with report/model/user rows and the
// panel showed moderator actions taken on unrelated entities. The index is
// (entityType, entityId, createdAt), so filtering by type is also what makes this an index scan.
async function getModActivity(
  imageId: number,
  limit = 50
): Promise<{ rows: ImageModActivity[]; truncated: boolean }> {
  const rows = await dbRead
    .selectFrom('ModActivity')
    .select(['id', 'activity', 'createdAt', 'userId'])
    .where('entityType', '=', 'image')
    .where('entityId', '=', imageId)
    .orderBy('createdAt', 'desc')
    .limit(limit + 1)
    .execute();

  const truncated = rows.length > limit;
  const byId = await usersByIds(rows.map((r) => r.userId ?? 0));
  const page = rows.slice(0, limit).map((r) => ({
    id: r.id,
    activity: r.activity,
    createdAt: r.createdAt,
    moderatorId: r.userId,
    moderatorUsername: r.userId ? byId.get(r.userId)?.username ?? null : null,
  }));

  return { rows: page, truncated };
}
