// No `$app/*` imports: the sidebar counts import this, and the node suites that load them cannot
// resolve `$app/server`.
import { sql } from 'kysely';
import type { CsamHoldSort, CsamHoldStatusFilter } from '$lib/csam-holds/hold-filters';
import { PREVIEW_COUNT_CAP } from '$lib/minor-flags/model-detail';
import { dbRead } from './db';
import { escapeLike } from './like';
import { MODEL_COVER_ORDER, modelCoverCount, modelCoverImages } from './model-covers';
import { MAX_INT4 } from './users.service';

export type CsamHoldRow = {
  id: number;
  entityType: string;
  entityId: number;
  userId: number | null;
  username: string | null;
  text: string;
  /** What a moderator reviewed; sent back with the decision so a hold edited underneath it is refused. */
  textHash: string;
  reason: string;
  workflowId: string | null;
  promptId: number | null;
  contentAt: Date | null;
  createdAt: Date;
  chatId: number | null;
  /** A chat hold's judged messages, and who sent them; empty and null for other types. */
  messageIds: number[];
  senderId: number | null;
  title: string | null;
  live: boolean | null;
  status: string;
  decidedAt: Date | null;
  decidedByUsername: string | null;
  decisionNote: string | null;
  decision: string | null;
  /** Held again with new text after a moderator ruled on this entity. */
  redetected: boolean;
  priorHoldId: number | null;
  priorStatus: string | null;
  priorDecidedAt: Date | null;
  priorDecidedByUsername: string | null;
};

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

const chatMessageIds = (value: unknown): number[] =>
  Array.isArray(value) ? value.filter((id): id is number => Number.isInteger(id)) : [];

/** The chat and judged messages of a `ChatMessage` hold; null for any other hold, or once retention cleared its meta. */
export async function getChatHold(
  holdId: number
): Promise<{ chatId: number; messageIds: number[]; senderId: number | null } | null> {
  const row = await dbRead
    .selectFrom('TextScanHold')
    .select(['entityId', 'meta'])
    .where('id', '=', holdId)
    .where('label', '=', 'csam')
    .where('entityType', '=', 'ChatMessage')
    .executeTakeFirst();
  if (!row) return null;
  const { chatId, messageIds, senderId } = (row.meta ?? {}) as Record<string, unknown>;
  if (typeof chatId !== 'number') return null;
  const judged = chatMessageIds(messageIds);
  return {
    chatId,
    messageIds: judged.length ? judged : [row.entityId],
    senderId: typeof senderId === 'number' ? senderId : null,
  };
}

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
    // The `~` guard keeps a malformed id from failing the whole list on the cast.
    .leftJoin('TextScanHold as ph', (join) =>
      join.on(
        sql<boolean>`ph.id = case when h.meta->>'priorHoldId' ~ '^[0-9]{1,9}$' then (h.meta->>'priorHoldId')::int end`
      )
    )
    .leftJoin('User as pd', 'pd.id', 'ph.decidedById')
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
      'h.textHash',
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
      'ph.status as priorStatus',
      'ph.decidedAt as priorDecidedAt',
      'pd.username as priorDecidedByUsername',
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
    const { chatId, decision, kind, priorHoldId, messageIds, senderId } = (meta ?? {}) as {
      chatId?: unknown;
      messageIds?: unknown;
      senderId?: unknown;
      decision?: unknown;
      kind?: unknown;
      priorHoldId?: unknown;
    };
    return {
      ...row,
      redetected: kind === 'redetected' && typeof priorHoldId === 'number',
      priorHoldId: typeof priorHoldId === 'number' ? priorHoldId : null,
      priorStatus: row.priorStatus ?? null,
      priorDecidedAt: row.priorDecidedAt ?? null,
      priorDecidedByUsername: row.priorDecidedByUsername ?? null,
      username: row.username ?? null,
      decidedByUsername: row.decidedByUsername ?? null,
      title: row.title ?? null,
      live: row.live ?? null,
      chatId: typeof chatId === 'number' ? chatId : null,
      messageIds: chatMessageIds(messageIds),
      senderId: typeof senderId === 'number' ? senderId : null,
      decision: typeof decision === 'string' ? decision : null,
    };
  });
  return { items, hasMore: rows.length > limit };
}

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

export async function countPendingCsamHolds(entityType?: string): Promise<number> {
  let query = csamHolds({ status: 'pending' });
  if (entityType) query = query.where('h.entityType', '=', entityType);
  const row = await query.select((eb) => eb.fn.countAll<string>().as('count')).executeTakeFirst();
  return Number(row?.count ?? 0);
}

export type CsamHoldImage = {
  id: number;
  url: string;
  nsfwLevel: number;
  type: string;
  minor: boolean;
  acceptableMinor: boolean;
};

export type CsamHoldCovers = { images: CsamHoldImage[]; total: number };

export const HOLD_IMAGE_LIMIT = 4;

type CoverRow = CsamHoldImage & { entityId: number; total: string };

const toCovers = (rows: CoverRow[]): Map<number, CsamHoldCovers> => {
  const byEntity = new Map<number, CsamHoldCovers>();
  for (const { entityId, total, ...image } of rows) {
    const entry = byEntity.get(entityId) ?? { images: [], total: Number(total) };
    entry.images.push(image);
    byEntity.set(entityId, entry);
  }
  return byEntity;
};

/** A post's first images and videos in post order (lowest `index`, then id). One read for every post, bounded per post. */
async function getPostCovers(postIds: number[]): Promise<Map<number, CsamHoldCovers>> {
  const { rows } = await sql<CoverRow>`
    select p.id as "entityId", c.id, c.url, c."nsfwLevel", c.type::text as type, c.minor, c."acceptableMinor", n.total
    from "Post" p
    cross join lateral (
      select i.id, i.url, i."nsfwLevel", i.type, i.minor, i."acceptableMinor", i.index
      from "Image" i
      where i."postId" = p.id and i.type::text in ('image', 'video')
      order by i.index asc nulls last, i.id asc
      limit ${sql.raw(String(HOLD_IMAGE_LIMIT))}
    ) c
    cross join lateral (
      select count(*)::int as total
      from (
        select 1 from "Image" i
        where i."postId" = p.id and i.type::text in ('image', 'video')
        limit ${sql.raw(String(PREVIEW_COUNT_CAP + 1))}
      ) capped
    ) n
    where p.id in (${sql.join(postIds)})
    order by p.id, c.index asc nulls last, c.id asc`.execute(dbRead);
  return toCovers(rows);
}

/** A model's first images and videos, chosen as the model flags queues choose theirs (`modelCoverImages`). One
 *  read for every model, bounded per model like the post covers. */
async function getModelCovers(modelIds: number[]): Promise<Map<number, CsamHoldCovers>> {
  const { rows } = await sql<CoverRow>`
    select m.id as "entityId", c.id, c.url, c."nsfwLevel", c.type, c.minor, c."acceptableMinor", n.total
    from "Model" m
    cross join lateral (${modelCoverImages(
      sql.ref('m.id'),
      sql.ref('m.userId'),
      HOLD_IMAGE_LIMIT
    )}) c
    cross join lateral (${modelCoverCount(
      sql.ref('m.id'),
      sql.ref('m.userId'),
      PREVIEW_COUNT_CAP + 1
    )}) n
    where m.id in (${sql.join(modelIds)})
    order by m.id, ${MODEL_COVER_ORDER}`.execute(dbRead);
  return toCovers(rows);
}

export async function getHoldCoverImages(
  holds: { id: number; entityType: string; entityId: number }[]
): Promise<Map<number, CsamHoldCovers>> {
  const idsOf = (type: string) => [
    ...new Set(holds.filter((h) => h.entityType === type).map((h) => h.entityId)),
  ];
  const postIds = idsOf('Post');
  const modelIds = idsOf('Model');
  const [posts, models] = await Promise.all([
    postIds.length ? getPostCovers(postIds) : new Map<number, CsamHoldCovers>(),
    modelIds.length ? getModelCovers(modelIds) : new Map<number, CsamHoldCovers>(),
  ]);
  const covers = new Map<number, CsamHoldCovers>();
  for (const h of holds) {
    const found = (h.entityType === 'Post' ? posts : h.entityType === 'Model' ? models : null)?.get(
      h.entityId
    );
    if (found) covers.set(h.id, found);
  }
  return covers;
}
