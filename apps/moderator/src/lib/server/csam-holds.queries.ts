// No `$app/*` imports: the sidebar counts import this, and the node suites that load them cannot
// resolve `$app/server`.
import { sql } from 'kysely';
import type { CsamHoldSort, CsamHoldStatusFilter } from '$lib/csam-holds/hold-filters';
import { dbRead } from './db';
import { escapeLike } from './like';
import { MAX_INT4 } from './users.service';

export type CsamHoldRow = {
  id: number;
  entityType: string;
  entityId: number;
  userId: number | null;
  username: string | null;
  text: string;
  reason: string;
  workflowId: string | null;
  promptId: number | null;
  contentAt: Date | null;
  createdAt: Date;
  chatId: number | null;
  /** The post's title or the model's name; null for other types, or when the content is gone or untitled. */
  title: string | null;
  /** Whether the held post or model is still published, false when its row is gone; null for types with no such state. */
  live: boolean | null;
  status: string;
  decidedAt: Date | null;
  decidedByUsername: string | null;
  decisionNote: string | null;
  /** The action taken, as the main app records it with the decision; null while pending. */
  decision: string | null;
};

/** A number matches the held content's id or its author's id; anything else is a username. */
export type CsamHoldSearch = { id: number } | { username: string };

export const csamHoldSearch = (q: string): CsamHoldSearch | undefined => {
  if (!q) return undefined;
  if (/^\d+$/.test(q)) return { id: Number(q) > MAX_INT4 ? 0 : Number(q) };
  return { username: q };
};

export type CsamHoldQuery = {
  status: CsamHoldStatusFilter;
  sort: CsamHoldSort;
  limit: number;
  offset: number;
  entityType?: string;
  search?: CsamHoldSearch;
};

const STATUS_COLUMN = { pending: 'Pending', removed: 'Confirmed', dismissed: 'Dismissed' } as const;

const csamHolds = ({
  status,
  search,
}: {
  status: CsamHoldStatusFilter;
  search?: CsamHoldSearch;
}) => {
  let query = dbRead
    .selectFrom('TextScanHold as h')
    .leftJoin('User as u', 'u.id', 'h.userId')
    .where('h.label', '=', 'csam');
  if (status !== 'all') query = query.where('h.status', '=', STATUS_COLUMN[status]);
  if (search && 'id' in search)
    query = query.where((eb) =>
      eb.or([eb('h.entityId', '=', search.id), eb('h.userId', '=', search.id)])
    );
  else if (search)
    query = query.where(
      sql<boolean>`lower(u.username) like lower(${escapeLike(search.username) + '%'})`
    );
  return query;
};

export async function listCsamHolds({
  limit,
  offset,
  entityType,
  status,
  sort,
  search,
}: CsamHoldQuery): Promise<{ items: CsamHoldRow[]; hasMore: boolean }> {
  let query = csamHolds({ status, search })
    .leftJoin('User as d', 'd.id', 'h.decidedById')
    // Titles and liveness come from the same page of rows, joined by type, so the list costs no extra queries.
    .leftJoin('Post as p', (join) =>
      join.onRef('p.id', '=', 'h.entityId').on('h.entityType', '=', 'Post')
    )
    .leftJoin('Model as m', (join) =>
      join.onRef('m.id', '=', 'h.entityId').on('h.entityType', '=', 'Model')
    )
    .select([
      'h.id',
      'h.entityType',
      'h.entityId',
      'h.userId',
      'u.username',
      'h.text',
      'h.reason',
      'h.workflowId',
      'h.promptId',
      'h.contentAt',
      'h.createdAt',
      'h.meta',
      'h.status',
      'h.decidedAt',
      'd.username as decidedByUsername',
      'h.decisionNote',
      sql<string | null>`coalesce(p.title, m.name)`.as('title'),
      sql<
        boolean | null
      >`case h."entityType" when 'Post' then p."publishedAt" is not null when 'Model' then coalesce(m.status::text = 'Published', false) end`.as(
        'live'
      ),
    ]);
  if (entityType) query = query.where('h.entityType', '=', entityType);
  const rows = await query
    .orderBy('h.createdAt', sort === 'newest' ? 'desc' : 'asc')
    .orderBy('h.id', sort === 'newest' ? 'desc' : 'asc')
    .limit(limit + 1)
    .offset(offset)
    .execute();

  const items = rows.slice(0, limit).map(({ meta, ...row }) => {
    const { chatId, decision } = (meta ?? {}) as { chatId?: unknown; decision?: unknown };
    return {
      ...row,
      username: row.username ?? null,
      decidedByUsername: row.decidedByUsername ?? null,
      title: row.title ?? null,
      live: row.live ?? null,
      chatId: typeof chatId === 'number' ? chatId : null,
      decision: typeof decision === 'string' ? decision : null,
    };
  });
  return { items, hasMore: rows.length > limit };
}

/** Holds per entity type for one status and search, ignoring the type filter so the chips stay put. */
export async function countCsamHoldsByType(args: {
  status: CsamHoldStatusFilter;
  search?: CsamHoldSearch;
}): Promise<Record<string, number>> {
  const rows = await csamHolds(args)
    .select(['h.entityType', (eb) => eb.fn.countAll<string>().as('count')])
    .groupBy('h.entityType')
    .execute();
  return Object.fromEntries(rows.map((r) => [r.entityType, Number(r.count)]));
}

/** What the sidebar badge shows: every pending csam hold. */
export async function countPendingCsamHolds(entityType?: string): Promise<number> {
  let query = csamHolds({ status: 'pending' });
  if (entityType) query = query.where('h.entityType', '=', entityType);
  const row = await query.select((eb) => eb.fn.countAll<string>().as('count')).executeTakeFirst();
  return Number(row?.count ?? 0);
}

export type CsamHoldImage = { id: number; url: string; nsfwLevel: number };

/** The first `limit` images of a held post in post order, and how many it has in all. Videos are left out:
 *  the preview renders stills. */
export async function getPostHoldImages(
  postId: number,
  limit: number
): Promise<{ images: CsamHoldImage[]; total: number }> {
  const rows = await dbRead
    .selectFrom('Image as i')
    .select(['i.id', 'i.url', 'i.nsfwLevel', sql<string>`count(*) over ()`.as('total')])
    .where('i.postId', '=', postId)
    .where(sql<boolean>`i.type::text = 'image'`)
    .orderBy(sql`i.index asc nulls last`)
    .orderBy('i.id', 'asc')
    .limit(limit)
    .execute();
  return {
    images: rows.map(({ id, url, nsfwLevel }) => ({ id, url, nsfwLevel })),
    total: rows.length ? Number(rows[0].total) : 0,
  };
}

const stillsOnly = sql<boolean>`i.type::text = 'image'`;

/** A post's first still: lowest `index`, then id. One row per post. */
async function getPostCovers(postIds: number[]): Promise<Map<number, string>> {
  const rows = await dbRead
    .selectFrom('Image as i')
    .distinctOn('i.postId')
    .select(['i.postId', 'i.url'])
    .where('i.postId', 'in', postIds)
    .where(stillsOnly)
    .orderBy('i.postId')
    .orderBy(sql`i.index asc nulls last`)
    .orderBy('i.id', 'asc')
    .execute();
  return new Map(rows.flatMap((r) => (r.postId === null ? [] : [[r.postId, r.url] as const])));
}

/** A model's first still, chosen as the model flags queues choose theirs: the owner's posts on its
 *  versions, published before unpublished, then version, post and image order. One row per model. */
async function getModelCovers(modelIds: number[]): Promise<Map<number, string>> {
  const rows = await dbRead
    .selectFrom('Model as m')
    .innerJoin('ModelVersion as mv', 'mv.modelId', 'm.id')
    .innerJoin('Post as p', (join) =>
      join.onRef('p.modelVersionId', '=', 'mv.id').onRef('p.userId', '=', 'm.userId')
    )
    .innerJoin('Image as i', 'i.postId', 'p.id')
    .distinctOn('m.id')
    .select(['m.id as modelId', 'i.url'])
    .where('m.id', 'in', modelIds)
    .where(stillsOnly)
    .orderBy('m.id')
    .orderBy(sql`p."publishedAt" is null`)
    .orderBy(sql`mv.index asc nulls last`)
    .orderBy('p.id', 'asc')
    .orderBy(sql`i.index asc nulls last`)
    .orderBy('i.id', 'asc')
    .execute();
  return new Map(rows.map((r) => [r.modelId, r.url]));
}

/** The thumbnail key of each post or model hold on a page, by hold id: two reads at most however many
 *  rows there are. Holds with no still, and other types, have no entry. */
export async function getHoldCoverUrls(
  holds: { id: number; entityType: string; entityId: number }[]
): Promise<Map<number, string>> {
  const idsOf = (type: string) => [
    ...new Set(holds.filter((h) => h.entityType === type).map((h) => h.entityId)),
  ];
  const postIds = idsOf('Post');
  const modelIds = idsOf('Model');
  const [posts, models] = await Promise.all([
    postIds.length ? getPostCovers(postIds) : new Map<number, string>(),
    modelIds.length ? getModelCovers(modelIds) : new Map<number, string>(),
  ]);
  const covers = new Map<number, string>();
  for (const h of holds) {
    const url = (h.entityType === 'Post' ? posts : h.entityType === 'Model' ? models : null)?.get(
      h.entityId
    );
    if (url) covers.set(h.id, url);
  }
  return covers;
}

/** What a hold points at, for reading its content; null when the id is not a csam hold. */
export async function getCsamHoldRef(
  holdId: number
): Promise<{ entityType: string; entityId: number } | null> {
  const row = await dbRead
    .selectFrom('TextScanHold as h')
    .select(['h.entityType', 'h.entityId'])
    .where('h.id', '=', holdId)
    .where('h.label', '=', 'csam')
    .executeTakeFirst();
  return row ?? null;
}
