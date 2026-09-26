import { Prisma } from '@prisma/client';
import dayjs from '~/shared/utils/dayjs';
import type { NextApiRequest } from 'next';
import { isProd } from '~/env/other';
import { INT4_MAX } from '~/server/schema/base.schema';
import type { PaginationInput } from '~/server/schema/base.schema';
import { throwBadRequestError } from '~/server/utils/errorHandling';
import { QS } from '~/utils/qs';

export const DEFAULT_PAGE_SIZE = 20;

export function getPagination(limit: number, page: number | undefined) {
  const take = limit > 0 ? limit : undefined;
  const skip = page && take ? (page - 1) * take : undefined;

  return { take, skip };
}

export function getPagingData<T>(
  data: { count?: number; items: T[]; hasMore?: boolean },
  limit?: number,
  page?: number
) {
  const { count: totalItems = 0, items, hasMore } = data;
  const currentPage = page ?? 1;
  const pageSize = limit ?? totalItems;

  // hasMore-based pagination (e.g. the creator username-search path, which drops
  // the expensive exact COUNT). No exact total is available, so totalItems and
  // totalPages are monotonic LOWER-BOUNDS: exact once we've reached the final
  // page (hasMore=false), otherwise "at least one more". `hasMore` is the
  // authoritative next-page signal and keeps getPaginationLinks' nextPage link
  // working (currentPage < totalPages ⇒ true while more pages remain).
  if (hasMore !== undefined) {
    const skipped = pageSize && currentPage > 1 ? (currentPage - 1) * pageSize : 0;
    const boundTotalItems = skipped + items.length + (hasMore ? 1 : 0);
    const totalPages = hasMore ? currentPage + 1 : currentPage;
    return { items, totalItems: boundTotalItems, currentPage, pageSize, totalPages, hasMore };
  }

  const totalPages = pageSize && totalItems ? Math.ceil((totalItems as number) / pageSize) : 1;

  return { items, totalItems, currentPage, pageSize, totalPages };
}

export function getPaginationLinks({
  req,
  totalPages,
  currentPage,
}: {
  req: NextApiRequest;
  totalPages: number;
  currentPage: number;
}) {
  const baseUrl = new URL(
    req.url ?? '/',
    isProd ? `https://${req.headers.host as string}` : 'http://localhost:3000'
  );
  const hasNextPage = currentPage < totalPages;
  const hasPrevPage = totalPages > 1 && currentPage > 1;
  const nextPageQueryString = hasNextPage
    ? QS.stringify({
        ...req.query,
        page: currentPage + 1,
      })
    : '';
  const prevPageQueryString = hasPrevPage
    ? QS.stringify({
        ...req.query,
        page: currentPage - 1,
      })
    : '';

  const nextPage = hasNextPage
    ? `${baseUrl.origin}${baseUrl.pathname}?${nextPageQueryString}`
    : undefined;
  const prevPage = hasPrevPage
    ? `${baseUrl.origin}${baseUrl.pathname}?${prevPageQueryString}`
    : undefined;

  return { nextPage, prevPage, baseUrl };
}

export async function getPagedData<TQuery extends PaginationInput, TData>(
  { page, limit, ...rest }: TQuery,
  fn: (
    args: { skip?: number; take?: number } & Omit<TQuery, 'page' | 'limit'>
  ) => Promise<{ items: TData; count?: number | bigint }>
) {
  const take = !page ? undefined : limit;
  const skip = !page ? undefined : (page - 1) * limit;

  const { items, count } = await fn({ skip, take, ...rest });
  const totalItems = Number(count) ?? 0;

  return {
    currentPage: page,
    pageSize: take,
    totalPages: !!take && !!count ? Math.ceil(totalItems / take) : 1,
    totalItems,
    items,
  };
}

type SortOrder = 'ASC' | 'DESC';

interface SortField {
  field: string;
  order: SortOrder;
}

function parseSortString(sortString: string): SortField[] {
  return sortString.split(',').map((part) => {
    const [field, order = 'ASC'] = part.trim().split(' ').filter(Boolean);
    return { field, order: order.toUpperCase() as SortOrder };
  });
}

function parseCursor(fields: SortField[], cursor: string | number | Date | bigint) {
  if (typeof cursor === 'number' || typeof cursor === 'bigint' || cursor instanceof Date) {
    // A scalar cursor carries exactly ONE value, so it is only well-formed for a
    // single-field sort. The arity guard below covers the string form; without
    // the same guard here, a scalar silently bound to `fields[0]` and the
    // remaining fields resolved to `undefined`.
    //
    // That was a live 500: `model.getAll` takes a JSON cursor, so a client can
    // send a bare number (a model id, say) where the sort is Newest/Oldest —
    // `mm."lastVersionAt" DESC NULLS LAST, mm|mbm."modelId" DESC`, two fields. The
    // number bound to the TIMESTAMP head field and Postgres threw
    // `date/time field value out of range: "165997"`, which surfaced as an
    // INTERNAL_SERVER_ERROR for what is a malformed client input. Note the
    // magnitude bound on the cursor schema cannot catch this — 165997 is a
    // perfectly ordinary int; the value is simply not a timestamp.
    //
    // Rejecting it as a 400 matches how the string form has been handled since
    // the `"|<id>"` NULL-token fix below. A legitimate cursor is always a value
    // this server issued as `nextCursor`: a bare column value for a single-field
    // sort, a `CONCAT(col, '|', …)` string otherwise — so no well-formed cursor
    // reaches this branch with a multi-field sort.
    if (fields.length !== 1) {
      throwBadRequestError(
        `Invalid cursor: expected ${fields.length} value(s) for this sort, received 1`
      );
    }
    return { [fields[0].field]: cursor };
  }

  const values = cursor.split('|');
  // A cursor whose token count doesn't match the sort's field arity is
  // malformed — typically a stale or hand-built cursor, or one carried across a
  // deploy that changed the sort's `orderBy` field count. Reject as 400 rather
  // than crashing on the next line's `values[i].includes(...)` (undefined →
  // TypeError), which fell through to handleEndpointError's unlogged 500 branch
  // — a silent, unattributable floor.
  if (values.length !== fields.length) {
    throwBadRequestError(
      `Invalid cursor: expected ${fields.length} value(s) for this sort, received ${values.length}`
    );
  }
  const result: Record<string, number | Date> = {};
  for (let i = 0; i < fields.length; i++) {
    const value = values[i];
    // Validate token contents (companion to the arity guard above). A cursor's
    // tokens come from the DB-computed `prop` (a bare column, or CONCAT(col, '|',
    // …) for a composite sort). When a sort column is NULL — e.g. a NULLS-LAST tail
    // reached via browse filters — `CONCAT(NULL, '|', id)` collapses to `'|id'`, so
    // this loop sees an empty token that parses to NaN (numeric) / Invalid Date. That
    // NaN/Invalid bound then hit the SQL comparison and Postgres threw
    // `invalid input syntax for type timestamp: "NaN"`, which surfaced as an
    // unattributable INTERNAL_SERVER_ERROR (500). Reject the malformed cursor as a
    // 400 instead. (Well-formed cursors carry real DB values, so this only fires on a
    // genuinely unparseable token — never on a legitimate cursor.)
    if (value.includes('-')) {
      const parsed = dayjs.utc(value);
      if (!parsed.isValid())
        throwBadRequestError(`Invalid cursor: unparseable date value "${value}"`);
      result[fields[i].field] = parsed.toDate();
    } else {
      const parsed = parseInt(value, 10);
      if (Number.isNaN(parsed))
        throwBadRequestError(`Invalid cursor: unparseable numeric value "${value}"`);
      // `keysetCursorSchema` bounds only the number/bigint spellings, so a string
      // token — every REST query param — needs the bound here. NOT redundant with it.
      //
      // Safe because every cursor-reachable sort column is int4: `i."index"`,
      // `i."id"`, `ct."collectionItemId"`, `irr."imageId"` (`image.service.ts`),
      // `ci."id"`, `mm|mbm."modelId"` and the `*Count` columns (`model.service.ts`).
      // `ct."sortKey"` caps at 1e9 and only pairs with a sort that bypasses this;
      // timestamps take the date branch. If a wider sort column is ever made
      // cursor-reachable, this guard must move with it.
      if (parsed > INT4_MAX)
        throwBadRequestError(`Invalid cursor: numeric value out of range "${value}"`);
      result[fields[i].field] = parsed;
    }
  }
  return result;
}

/**
 * The cursor a caller hands out is the LOOKAHEAD row (`LIMIT n + 1`, then popped), so the
 * next page must include that row: inclusive on the last sort field, strict on every head
 * field. A strict last field skips the cursor row on every page (issue #1372, `sort=Newest`);
 * an inclusive head field re-emits every row tied on it (`sort=Oldest`).
 */
function cursorOperator(order: SortOrder, isLastField: boolean) {
  if (order === 'DESC') return isLastField ? '<=' : '<';
  return isLastField ? '>=' : '>';
}

export function getCursor(sortString: string, cursor: string | number | bigint | Date | undefined) {
  const sortFields = parseSortString(sortString);
  let where: Prisma.Sql | undefined;
  if (cursor) {
    const cursors = parseCursor(sortFields, cursor);
    const conditions: Prisma.Sql[] = [];
    const lastIdx = sortFields.length - 1;

    for (let i = 0; i < sortFields.length; i++) {
      const conditionParts: Prisma.Sql[] = [];
      for (let j = 0; j <= i; j++) {
        const { field, order } = sortFields[j];
        const operator = j < i ? '=' : cursorOperator(order, i === lastIdx);

        conditionParts.push(
          Prisma.sql`${Prisma.raw(field)} ${Prisma.raw(operator)} ${cursors[field]}`
        );
      }
      conditions.push(Prisma.sql`(${Prisma.join(conditionParts, ' AND ')})`);
    }

    where = Prisma.sql`(${Prisma.join(conditions, ' OR ')})`;
  }

  const sortProps = sortFields.map((x) => x.field);
  const prop =
    sortFields.length === 1 ? sortFields[0].field : `CONCAT(${sortProps.join(`, '|', `)})`;
  return {
    where,
    prop,
  };
}

/**
 * Split-cursor variant of {@link getCursor} that returns the cursor predicate as
 * two separate clauses suitable for a UNION ALL rewrite.
 *
 * The standard `getCursor` produces an OR-chain like:
 *   (A < a) OR (A = a AND B < b) OR (A = a AND B = b AND C <= c)
 *
 * Postgres can't push that OR predicate into an index seek — it scans the entire
 * matching range and applies a Filter, which is fast for page 1 but slows
 * dramatically at deep offsets (~211 ms vs ~7 ms in production).
 *
 * When the split is applicable (cursor present, ≥2 sort fields, head fields all
 * DESC), `getCursorClauses` returns:
 *   - `strict`: (A, ..., second_to_last) < (cursorA, ..., cursorPenult)
 *               — pushes into an `Index Cond: ROW(...) < ROW(...)` seek
 *   - `equality`: A = a AND ... AND penultimate = penultimateCursor AND last <=/>= lastCursor
 *               — the cursor row and the rest of its head-field tie (rows sorting at or after it)
 * with `splittable=true`. Combining `(strict UNION ALL equality)` reproduces the
 * original result set with the same ordering and allows the index seek.
 *
 * In all other cases (no cursor, single-field sort, or non-DESC head fields)
 * `getCursorClauses` returns the legacy single OR-predicate in `strict` with
 * `splittable=false`. The caller should AND that into its existing WHERE.
 *
 * Why DESC-only? The tuple compare is written for `<` only, and every multi-field sort
 * except `Oldest` has DESC head fields, so ASC-headed sorts keep the OR-predicate. An
 * all-ASC head could split the same way with `>`; nothing semantic prevents it.
 *
 * The `prop` (cursorId encoding) matches `getCursor` exactly so callers can
 * swap helpers without touching pagination state.
 */
export function getCursorClauses(
  sortString: string,
  cursor: string | number | bigint | Date | undefined
) {
  const sortFields = parseSortString(sortString);
  const sortProps = sortFields.map((x) => x.field);
  const prop =
    sortFields.length === 1 ? sortFields[0].field : `CONCAT(${sortProps.join(`, '|', `)})`;

  if (!cursor) {
    return { strict: undefined, equality: undefined, prop, splittable: false };
  }

  const cursors = parseCursor(sortFields, cursor);

  // Helper: rebuild the legacy `getCursor` OR-predicate over the full sort.
  // Used as a single-branch fallback when split isn't applicable.
  const buildLegacyPredicate = (): Prisma.Sql => {
    const conditions: Prisma.Sql[] = [];
    const lastIdx = sortFields.length - 1;
    for (let i = 0; i < sortFields.length; i++) {
      const conditionParts: Prisma.Sql[] = [];
      for (let j = 0; j <= i; j++) {
        const { field, order } = sortFields[j];
        const operator = j < i ? '=' : cursorOperator(order, i === lastIdx);
        conditionParts.push(
          Prisma.sql`${Prisma.raw(field)} ${Prisma.raw(operator)} ${cursors[field]}`
        );
      }
      conditions.push(Prisma.sql`(${Prisma.join(conditionParts, ' AND ')})`);
    }
    return Prisma.sql`(${Prisma.join(conditions, ' OR ')})`;
  };

  // Single-field sort: one inequality, already index-seekable.
  if (sortFields.length === 1) {
    return { strict: buildLegacyPredicate(), equality: undefined, prop, splittable: false };
  }

  // No tuple compare is written for non-DESC heads; see "Why DESC-only?" above.
  const lastIdx = sortFields.length - 1;
  const headFields = sortFields.slice(0, lastIdx);
  const allHeadDesc = headFields.every((f) => f.order === 'DESC');
  if (!allHeadDesc) {
    return { strict: buildLegacyPredicate(), equality: undefined, prop, splittable: false };
  }

  // Splittable case: head fields all DESC.
  // Strict branch: (head fields) < (head cursor values) as a tuple compare,
  // which Postgres pushes into an `Index Cond: ROW(...) < ROW(...)` seek.
  const fieldList = Prisma.join(
    headFields.map((f) => Prisma.raw(f.field)),
    ', '
  );
  const valueList = Prisma.join(
    headFields.map((f) => Prisma.sql`${cursors[f.field]}`),
    ', '
  );
  const strict = Prisma.sql`((${fieldList}) < (${valueList}))`;

  const lastField = sortFields[lastIdx];
  const equalityParts: Prisma.Sql[] = headFields.map(
    ({ field }) => Prisma.sql`${Prisma.raw(field)} = ${cursors[field]}`
  );
  const lastOperator = cursorOperator(lastField.order, true);
  equalityParts.push(
    Prisma.sql`${Prisma.raw(lastField.field)} ${Prisma.raw(lastOperator)} ${
      cursors[lastField.field]
    }`
  );
  const equality = Prisma.sql`(${Prisma.join(equalityParts, ' AND ')})`;

  return { strict, equality, prop, splittable: true };
}

export function getNextPage({
  req,
  currentPage,
  nextCursor,
}: {
  req: NextApiRequest;
  nextCursor?: string | bigint | Date;
  currentPage?: number;
}) {
  const baseUrl = new URL(
    req.url ?? '/',
    isProd ? `https://${req.headers.host as string}` : 'http://localhost:3000'
  );

  const hasNextPage = !!nextCursor;
  if (!hasNextPage) return { baseUrl, nextPage: undefined };

  const queryParams: MixedObject = { ...req.query };
  if (currentPage) queryParams.page = currentPage + 1;
  else queryParams.cursor = nextCursor instanceof Date ? nextCursor.toISOString() : nextCursor;

  return { baseUrl, nextPage: `${baseUrl.origin}${baseUrl.pathname}?${QS.stringify(queryParams)}` };
}
