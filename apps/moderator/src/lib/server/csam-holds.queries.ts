// No `$app/*` imports: the sidebar counts import this, and the node suites that load them cannot
// resolve `$app/server`.
import { sql } from 'kysely';
import type { CsamHoldSort, CsamHoldStatusFilter } from '$lib/csam-holds/hold-filters';
import { PREVIEW_COUNT_CAP } from '$lib/minor-flags/model-detail';
import { dbRead } from './db';
import { escapeLike } from './like';
import { MODEL_COVER_ORDER, modelCoverCount, modelCoverImages } from './model-covers';
import { postCoverRows } from './post-covers';
import { MAX_INT4 } from './users.service';

export type CsamHoldRow = {
  id: number;
  entityType: string;
  entityId: number;
  userId: number | null;
  username: string | null;
  text: string;
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
  /** The model a legacy `Comment` hold was posted on. */
  commentModelId: number | null;
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
  /** Text a moderator ruled on before, put back on this pending hold by a later edit. */
  ruledBefore: { holdId: number; status: string } | null;
  /** When an edit last replaced this pending hold's text; null while it holds the text first detected. */
  textUpdatedAt: string | null;
  /** Text this pending hold held before later edits replaced it, newest first; plain text, cut at `EARLIER_TEXT_CHARS`. */
  earlierTexts: { text: string; at: string | null }[];
  /** Other pending holds by the same author, across the whole queue and not just this page. */
  otherPendingByAuthor: number;
  /** Other pending holds by the same author in the same chat; 0 for any hold that is not a chat message. */
  otherPendingInChat: number;
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
  /** Only the holds written by this user, which `search` by id would mix with holds on a content id. */
  author?: number;
};

const STATUS_COLUMN = { pending: 'Pending', removed: 'Confirmed', dismissed: 'Dismissed' } as const;

const csamHolds = ({
  status,
  search,
  author,
}: {
  status: CsamHoldStatusFilter;
  search?: CsamHoldSearch;
  author?: number;
}) => {
  let query = dbRead
    .selectFrom('TextScanHold as h')
    .leftJoin('User as u', 'u.id', 'h.userId')
    .where('h.label', '=', 'csam');
  if (status !== 'all') query = query.where('h.status', '=', STATUS_COLUMN[status]);
  if (author !== undefined) query = query.where('h.userId', '=', author);
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

export const EARLIER_TEXT_CHARS = 4000;

const earlierTextsOf = (value: unknown): CsamHoldRow['earlierTexts'] =>
  Array.isArray(value)
    ? value.flatMap((entry) => {
        const { text, at } = (entry ?? {}) as { text?: unknown; at?: unknown };
        return typeof text === 'string'
          ? [{ text: text.slice(0, EARLIER_TEXT_CHARS), at: typeof at === 'string' ? at : null }]
          : [];
      })
    : [];

const ruledBeforeOf = (value: unknown): CsamHoldRow['ruledBefore'] => {
  const { holdId, status } = (value ?? {}) as { holdId?: unknown; status?: unknown };
  return typeof holdId === 'number' && typeof status === 'string' ? { holdId, status } : null;
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
  author,
}: CsamHoldQuery): Promise<{ items: CsamHoldRow[]; hasMore: boolean }> {
  let query = csamHolds({ status, search, author })
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
    .leftJoin('Comment as lc', (join) =>
      join.onRef('lc.id', '=', 'h.entityId').on('h.entityType', '=', 'Comment')
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
      'lc.modelId as commentModelId',
      sql<number>`case when h.status = 'Pending' and h."userId" is not null then (
        select count(*)::int from "TextScanHold" x
        where x."userId" = h."userId" and x.label = 'csam' and x.status = 'Pending' and x.id <> h.id
      ) else 0 end`.as('otherPendingByAuthor'),
      sql<number>`case when h.status = 'Pending' and h."userId" is not null and h."entityType" = 'ChatMessage' and h.meta->>'chatId' is not null then (
        select count(*)::int from "TextScanHold" x
        where x."userId" = h."userId" and x."entityType" = 'ChatMessage' and x.label = 'csam'
          and x.status = 'Pending' and x.id <> h.id and x.meta->>'chatId' = h.meta->>'chatId'
      ) else 0 end`.as('otherPendingInChat'),
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
    const {
      chatId,
      decision,
      kind,
      priorHoldId,
      messageIds,
      senderId,
      previous,
      ruledBefore,
      textUpdatedAt,
    } = (meta ?? {}) as {
      textUpdatedAt?: unknown;
      previous?: unknown;
      ruledBefore?: unknown;
      chatId?: unknown;
      messageIds?: unknown;
      senderId?: unknown;
      decision?: unknown;
      kind?: unknown;
      priorHoldId?: unknown;
    };
    const earlierTexts = earlierTextsOf(previous);
    return {
      ...row,
      earlierTexts,
      textUpdatedAt:
        typeof textUpdatedAt === 'string' ? textUpdatedAt : earlierTexts[0]?.at ?? null,
      ruledBefore: ruledBeforeOf(ruledBefore),
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
      commentModelId: row.commentModelId ?? null,
      decision: typeof decision === 'string' ? decision : null,
    };
  });
  return { items, hasMore: rows.length > limit };
}

export type AuthorHoldSummary = {
  id: number;
  entityType: string;
  entityId: number;
  status: string;
  decision: string | null;
  reason: string;
  createdAt: Date;
  decidedAt: Date | null;
  /** Only for a pending hold: what a decision applied together with this one has to echo back. */
  textHash: string | null;
};

export type HoldAuthorHolds = {
  userId: number;
  /** Every other hold of the author, counting the decided ones beyond `others`. */
  total: number;
  /** All the author's other pending holds; every one is in `others`. */
  pendingTotal: number;
  /** Every pending hold and the newest `AUTHOR_HOLDS_LIMIT` decided ones, newest first. */
  others: AuthorHoldSummary[];
};

export const AUTHOR_HOLDS_LIMIT = 50;
/** Bounds one selection's payload; "also apply" takes at most 50 a time anyway. */
export const AUTHOR_PENDING_READ_MAX = 500;

// The migration's superseded duplicates were never ruled on, so they are not history.
const notSuperseded = sql<boolean>`h.meta->>'decision' is distinct from 'superseded'`;

/** The other csam holds of a hold's author, newest first; null when the hold is missing or has no recorded author. */
export async function getHoldAuthorHolds(holdId: number): Promise<HoldAuthorHolds | null> {
  const hold = await dbRead
    .selectFrom('TextScanHold')
    .select('userId')
    .where('id', '=', holdId)
    .where('label', '=', 'csam')
    .executeTakeFirst();
  const userId = hold?.userId;
  if (!userId) return null;

  const others = () =>
    dbRead
      .selectFrom('TextScanHold as h')
      .where('h.userId', '=', userId)
      .where('h.label', '=', 'csam')
      .where('h.id', '<>', holdId)
      .where(notSuperseded);
  const summary = () =>
    others()
      .select([
        'h.id',
        'h.entityType',
        'h.entityId',
        'h.status',
        'h.reason',
        'h.createdAt',
        'h.decidedAt',
        sql<string | null>`h.meta->>'decision'`.as('decision'),
        sql<string | null>`case when h.status = 'Pending' then h."textHash" end`.as('textHash'),
      ])
      .orderBy('h.createdAt', 'desc')
      .orderBy('h.id', 'desc');
  // Pending holds are read apart from the decided ones: a cap on the newest of all statuses would leave
  // older pending holds out of the counts and out of "also apply". Counts come from the table, so the
  // read caps can't make them lie.
  const count = (pending: boolean) =>
    others()
      .where('h.status', pending ? '=' : '<>', 'Pending')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .executeTakeFirst()
      .then((row) => Number(row?.count ?? 0));
  const [pending, decided, pendingTotal, decidedTotal] = await Promise.all([
    summary().where('h.status', '=', 'Pending').limit(AUTHOR_PENDING_READ_MAX).execute(),
    summary().where('h.status', '<>', 'Pending').limit(AUTHOR_HOLDS_LIMIT).execute(),
    count(true),
    count(false),
  ]);
  const byNewest = (a: AuthorHoldSummary, b: AuthorHoldSummary) =>
    b.createdAt.getTime() - a.createdAt.getTime() || b.id - a.id;
  return {
    userId,
    total: pendingTotal + decidedTotal,
    pendingTotal,
    others: [...pending, ...decided].sort(byNewest),
  };
}

/** Of `ids`, the pending holds with the same author as `holdId`. */
export async function filterAuthorPendingHolds(
  holdId: number,
  ids: number[]
): Promise<{ id: number; entityType: string }[]> {
  if (!ids.length) return [];
  return dbRead
    .selectFrom('TextScanHold as h')
    .innerJoin('TextScanHold as o', 'o.userId', 'h.userId')
    .select(['o.id', 'o.entityType'])
    .where('h.id', '=', holdId)
    .where('h.label', '=', 'csam')
    .where('o.label', '=', 'csam')
    .where('o.status', '=', 'Pending')
    .where('o.id', '<>', holdId)
    .where('o.id', 'in', ids)
    .execute();
}

/**
 * Of these pending holds, the ones whose entity was scanned again since, on other text, with the csam
 * label evaluated and not detected: the content was edited after the hold and no longer says what the
 * hold quotes. Keyed by hold id, valued with when that scan was recorded. A chat message is judged in a
 * window of messages, not as one text, so it is never listed. The hold stays open: a moderator decides.
 */
export async function getCleanRescans(
  holds: { id: number; entityType: string; entityId: number }[]
): Promise<Map<number, Date>> {
  const ids = holds.filter((h) => h.entityType !== 'ChatMessage').map((h) => h.id);
  if (!ids.length) return new Map();
  // The shadow row is the same entity scanned while the type was not yet active.
  const { rows } = await sql<{ id: number; scannedAt: Date }>`
    select t.id, t."scannedAt" from (
      select distinct on (h.id) h.id, em."updatedAt" as "scannedAt", em.status::text as status,
        em.result->>'textHash' as "scannedHash", h."textHash" as "heldHash",
        em.result->'labels'->'csam'->>'detected' as detected
      from "TextScanHold" h
      join "EntityModeration" em
        on em."entityId" = h."entityId" and em."entityType" in (h."entityType", h."entityType" || ':shadow')
      where h.id in (${sql.join(ids)}) and h.status = 'Pending' and h.label = 'csam'
      order by h.id, em."updatedAt" desc, em.id desc
    ) t
    where t.status = 'Succeeded' and t."scannedHash" is not null and t."scannedHash" <> t."heldHash"
      and t.detected = 'false'`.execute(dbRead);
  return new Map(rows.map((row) => [row.id, new Date(row.scannedAt)]));
}

export async function countCsamHoldsByType(args: {
  status: CsamHoldStatusFilter;
  search?: CsamHoldSearch;
  author?: number;
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

type CoverRow = CsamHoldImage & { entityId: number; total: number | string };

const toCovers = (rows: CoverRow[]): Map<number, CsamHoldCovers> => {
  const byEntity = new Map<number, CsamHoldCovers>();
  for (const { entityId, total, ...image } of rows) {
    const entry = byEntity.get(entityId) ?? { images: [], total: Number(total) };
    entry.images.push(image);
    byEntity.set(entityId, entry);
  }
  return byEntity;
};

/** A post's first images and videos in post order (lowest `index`, then id). */
async function getPostCovers(postIds: number[]): Promise<Map<number, CsamHoldCovers>> {
  const rows = await postCoverRows(postIds, {
    limit: HOLD_IMAGE_LIMIT,
    mediaTypes: ['image', 'video'],
    countCap: PREVIEW_COUNT_CAP + 1,
  });
  return toCovers(rows.map(({ postId, ...row }) => ({ entityId: postId, ...row })));
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

/** Cover media for `Post` and `Model` references, keyed `Type:id`; other types are skipped. */
export async function getEntityCovers(
  refs: { type: string; id: number }[]
): Promise<Map<string, CsamHoldCovers>> {
  const idsOf = (type: string) => [
    ...new Set(refs.filter((r) => r.type === type).map((r) => r.id)),
  ];
  const postIds = idsOf('Post');
  const modelIds = idsOf('Model');
  const [posts, models] = await Promise.all([
    postIds.length ? getPostCovers(postIds) : new Map<number, CsamHoldCovers>(),
    modelIds.length ? getModelCovers(modelIds) : new Map<number, CsamHoldCovers>(),
  ]);
  const covers = new Map<string, CsamHoldCovers>();
  for (const [id, found] of posts) covers.set(`Post:${id}`, found);
  for (const [id, found] of models) covers.set(`Model:${id}`, found);
  return covers;
}

export async function getHoldCoverImages(
  holds: { id: number; entityType: string; entityId: number }[]
): Promise<Map<number, CsamHoldCovers>> {
  const found = await getEntityCovers(holds.map((h) => ({ type: h.entityType, id: h.entityId })));
  const covers = new Map<number, CsamHoldCovers>();
  for (const h of holds) {
    const entry = found.get(`${h.entityType}:${h.entityId}`);
    if (entry) covers.set(h.id, entry);
  }
  return covers;
}
