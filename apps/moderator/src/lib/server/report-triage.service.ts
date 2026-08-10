import { sql } from '@civitai/db/kysely';
import { dbRead } from './db';
import type { MediaType } from '$lib/media/edge-url';
import type { Capped } from './user-account.service';

// The suspect's own content, for reviewing a report against an account without leaving the queue
// (Retool's TOSImages + GetImageCount).
//
// The queue itself is NOT here: it is `getReports({ type: ReportEntity.User })` in reports.service.ts.
// A parallel query was written first and had already diverged from `getReportCounts` on which reasons
// it excludes, so the sidebar badge and the page heading disagreed about the same queue.

export type SuspectImage = {
  id: number;
  url: string;
  /** `type` and `name` both feed media-type inference. Without them every video renders through the
   *  image pipeline, in a grid whose whole purpose is judging what this account posted. */
  type: MediaType;
  name: string | null;
  nsfwLevel: number;
  createdAt: Date;
  postId: number | null;
  tosViolation: boolean;
  needsReview: string | null;
  ingestion: string;
  blockedFor: string | null;
  prompt: string | null;
  negativePrompt: string | null;
};

/** Retool's "Images" and "Remaining" queue columns: `remaining` is what a colleague has not already
 *  removed, and is the number that says whether an account still needs work.
 *
 *  ⚠️ Client-fetched, never in `load`. `ingestion` is not in `Image_userId_postId_idx`, so the
 *  `remaining` case expression turns an Index-Only Scan into a heap scan: measured 67 ms → 8.3 s over
 *  50 queued users. Retool left the same column commented out. Putting it back in the page load blanks
 *  the queue for eight seconds on every write. */
export async function getImageCountsForUsers(
  userIds: number[]
): Promise<Map<number, { total: number; remaining: number }>> {
  const ids = [...new Set(userIds.filter((id) => id > 0))];
  if (!ids.length) return new Map();

  const rows = await dbRead
    .selectFrom('Image')
    .select((eb) => [
      'userId',
      eb.fn.countAll<string>().as('total'),
      eb.fn.count<string>(sql`case when "ingestion" <> 'Blocked' then 1 end`).as('remaining'),
    ])
    .where('userId', 'in', ids)
    .groupBy('userId')
    .execute();

  return new Map(
    rows.map((r) => [r.userId, { total: Number(r.total), remaining: Number(r.remaining) }])
  );
}

/** A pasted prompt fragment is full of `\(` escapes and `_` tokens. Unescaped, a trailing `\` eats the
 *  closing `%` and the search silently matches nothing — the account then reads clean for that phrase. */
const contains = (term: string) => `%${term.replace(/([\\%_])/g, '\\$1')}%`;

export type SuspectImageFilters = {
  tosOnly: boolean;
  noPrompt: boolean;
  levels: number[];
  from: Date | null;
  to: Date | null;
  prompt: string;
  negativePrompt: string;
};

export const EMPTY_SUSPECT_FILTERS: SuspectImageFilters = {
  tosOnly: false,
  noPrompt: false,
  levels: [],
  from: null,
  to: null,
  prompt: '',
  negativePrompt: '',
};

export async function getSuspectImages(
  userId: number,
  filters: SuspectImageFilters = EMPTY_SUSPECT_FILTERS,
  { limit = 60, cursor }: { limit?: number; cursor?: number } = {}
): Promise<
  Capped<SuspectImage> & { total: number; blocked: number; matched: number; nextCursor?: number }
> {
  const base = dbRead.selectFrom('Image').where('userId', '=', userId);

  const filtered = (() => {
    let q = base;
    // `tosViolation` alone misses everything removed from this very page: `handleBlockImages` sets
    // `ingestion='Blocked', blockedFor='moderated'` and never touches that column. Retool's predicate
    // was the ingestion one; both are kept so a manual ToS flag still matches. `AiNotVerified` is a
    // scanner outcome, not a moderator decision, which is why Retool excluded it.
    if (filters.tosOnly)
      q = q.where(
        sql<boolean>`("tosViolation" = true OR ("ingestion" = 'Blocked' AND "blockedFor" IS DISTINCT FROM 'AiNotVerified'))`
      );
    // `meta` is null on an upload and `{}` on a wipe; both are "no prompt" to a moderator.
    if (filters.noPrompt) q = q.where(sql<boolean>`coalesce("meta" ->> 'prompt', '') = ''`);
    if (filters.levels.length) q = q.where('nsfwLevel', 'in', filters.levels);
    if (filters.from) q = q.where('createdAt', '>=', filters.from);
    if (filters.to) q = q.where('createdAt', '<=', filters.to);
    if (filters.prompt)
      q = q.where(sql<boolean>`"meta" ->> 'prompt' ILIKE ${contains(filters.prompt)}`);
    if (filters.negativePrompt)
      q = q.where(
        sql<boolean>`"meta" ->> 'negativePrompt' ILIKE ${contains(filters.negativePrompt)}`
      );
    return q;
  })();

  const [rows, counts, matchedRow] = await Promise.all([
    (cursor ? filtered.where('id', '<', cursor) : filtered)
      .select([
        'id',
        'url',
        'type',
        'name',
        'nsfwLevel',
        'createdAt',
        'postId',
        'tosViolation',
        'needsReview',
        'ingestion',
        'blockedFor',
        sql<string | null>`"meta" ->> 'prompt'`.as('prompt'),
        sql<string | null>`"meta" ->> 'negativePrompt'`.as('negativePrompt'),
      ])
      .orderBy('id', 'desc')
      .limit(limit + 1)
      .execute(),
    base
      .select((eb) => [
        eb.fn.countAll<string>().as('total'),
        eb.fn.count<string>(sql`case when "ingestion" = 'Blocked' then 1 end`).as('blocked'),
      ])
      .executeTakeFirst(),
    filtered.select((eb) => eb.fn.countAll<string>().as('matched')).executeTakeFirst(),
  ]);

  const items = rows.slice(0, limit) as unknown as SuspectImage[];
  const truncated = rows.length > limit;
  return {
    items,
    truncated,
    nextCursor: truncated ? items[items.length - 1]?.id : undefined,
    total: Number(counts?.total ?? 0),
    blocked: Number(counts?.blocked ?? 0),
    matched: Number(matchedRow?.matched ?? 0),
  };
}
