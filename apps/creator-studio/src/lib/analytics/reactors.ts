// Dislike is excluded: thumbs-down is retired from the UI and out of scope for this list.
export const REACTOR_TYPES = ['Like', 'Heart', 'Laugh', 'Cry'] as const;
export type ReactorType = (typeof REACTOR_TYPES)[number];

export const REACTORS_PAGE_SIZE = 50;
// userId is an Int4 column; a larger cursor would make Postgres reject the bind and surface as a 500.
const MAX_USER_ID = 2_147_483_647;

export type ReactorCursor = { dir: 'after' | 'before'; userId: number } | null;
export type ReactorQuery = { reaction: ReactorType | null; cursor: ReactorCursor };

export type Reactor = {
  userId: number;
  username: string | null;
  image: string | null;
  reactedAt: string;
  deleted: boolean;
  banned: boolean;
};

export type ReactorPage = {
  reaction: ReactorType | null;
  counts: Record<ReactorType, number>;
  reactors: Reactor[];
  /** Pass as `after` for the next page (older accounts), or null on the last page. */
  next: number | null;
  /** Pass as `before` for the previous page (newer accounts), or null on the first page. */
  prev: number | null;
};

function isReactorType(v: string): v is ReactorType {
  return (REACTOR_TYPES as readonly string[]).includes(v);
}

function parseUserId(raw: string): number | null {
  if (!/^[1-9]\d{0,9}$/.test(raw)) return null;
  const n = Number(raw);
  return n <= MAX_USER_ID ? n : null;
}

export function parseReactorQuery(
  params: URLSearchParams
): { ok: true; value: ReactorQuery } | { ok: false; message: string } {
  const rawReaction = params.get('reaction');
  if (rawReaction !== null && !isReactorType(rawReaction))
    return { ok: false, message: 'Unknown reaction type' };

  const after = params.get('after');
  const before = params.get('before');
  if (after !== null && before !== null)
    return { ok: false, message: 'Pass either after or before, not both' };

  let cursor: ReactorCursor = null;
  const raw = after ?? before;
  if (raw !== null) {
    const userId = parseUserId(raw);
    if (userId === null) return { ok: false, message: 'Invalid cursor' };
    cursor = { dir: after !== null ? 'after' : 'before', userId };
  }
  // A cursor only means something within one reaction's list.
  if (cursor && rawReaction === null)
    return { ok: false, message: 'A cursor needs a reaction type' };

  return { ok: true, value: { reaction: rawReaction, cursor } };
}

export function emptyCounts(): Record<ReactorType, number> {
  return { Like: 0, Heart: 0, Laugh: 0, Cry: 0 };
}

/** The tab to open when the caller named none: the first type anyone used, in display order. */
export function defaultReaction(counts: Record<ReactorType, number>): ReactorType | null {
  return REACTOR_TYPES.find((t) => counts[t] > 0) ?? null;
}

/**
 * Turns one keyset fetch of up to `PAGE_SIZE + 1` rows into a page, newest account first. `rows` arrive in the
 * fetch's own order: descending for `after` (and the first page), ascending for `before`. The extra row only
 * says whether more exist in the fetch direction; it is never shown.
 */
export function assembleReactorPage<T extends { userId: number }>(
  rows: T[],
  cursor: ReactorCursor
): { rows: T[]; next: number | null; prev: number | null } {
  const more = rows.length > REACTORS_PAGE_SIZE;
  const kept = rows.slice(0, REACTORS_PAGE_SIZE);

  if (cursor?.dir === 'before') {
    const page = kept.reverse();
    return {
      rows: page,
      next: page.at(-1)?.userId ?? null,
      prev: more ? page[0].userId : null,
    };
  }
  return {
    rows: kept,
    next: more ? kept[kept.length - 1].userId : null,
    prev: cursor ? (kept[0]?.userId ?? null) : null,
  };
}
