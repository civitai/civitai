import {
  recordBitdexQueryFailure,
  type BitdexQueryFailureReason,
} from '~/server/metrics/bitdex-feed-serve.metrics';
import { withSpan, safeUrl } from '~/server/utils/otel-helpers';

export type Value = { Integer: number } | { Bool: boolean } | { String: string };

export type FilterClause =
  | { Eq: [string, Value] }
  | { NotEq: [string, Value] }
  | { Gt: [string, Value] }
  | { Gte: [string, Value] }
  | { Lt: [string, Value] }
  | { Lte: [string, Value] }
  | { In: [string, Value[]] }
  | { NotIn: [string, Value[]] }
  | { And: FilterClause[] }
  | { Or: FilterClause[] }
  | { Not: FilterClause }
  | { IsNull: string }
  | { IsNotNull: string };

export type SortClause = { field: string; direction: 'Asc' | 'Desc' };

const BITDEX_URL = process.env.BITDEX_URL || '';
// The batch documents endpoint sits in BitDex's admin route group (unlike
// /query, which is open). require_admin waives auth for no-X-Forwarded-For
// (in-cluster) traffic, so the token is only required when BITDEX_URL routes
// through a proxy that adds XFF. Only fetchBitdexDocuments uses this.
const BITDEX_ADMIN_TOKEN = process.env.BITDEX_ADMIN_TOKEN || '';
const BITDEX_TIMEOUT_MS = 30000;

export type BitdexDocument = Record<string, unknown> & { id: number };

/**
 * Fetch documents by slot ID (= Postgres ID) from BitDex's batch document endpoint.
 *
 * Unlike queryBitdex, this THROWS on any failure. Its caller is the consistency
 * audit, where a swallowed error would read as "no mismatches found" — a silent
 * pass is the one outcome an audit must never produce.
 *
 * BitDex returns a row for every requested slot; a document that is not on disk
 * comes back as bare `{ id }` with no other fields, so absence is observable
 * rather than being conflated with a dropped row.
 */
export async function fetchBitdexDocuments(
  indexName: string,
  slotIds: number[],
  fields?: string[]
): Promise<BitdexDocument[]> {
  if (!BITDEX_URL) throw new Error('BITDEX_URL is not configured');
  if (!slotIds.length) return [];

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), BITDEX_TIMEOUT_MS);
  const url = `${BITDEX_URL}/api/indexes/${indexName}/documents`;
  const urlAttr = safeUrl(url);
  try {
    const res = await withSpan(
      'bitdex:http:documents',
      { 'http.method': 'POST', 'http.url': urlAttr, 'bitdex.namespace': indexName },
      () =>
        fetch(url, {
          method: 'POST',
          // BitDex's require_admin waives auth for traffic without an
          // X-Forwarded-For header (in-cluster calls); routed-through-proxy
          // calls need the bearer. Send it when configured; if it's needed
          // and absent, the 401 fails the fetch loudly — never a silent pass.
          headers: {
            'Content-Type': 'application/json',
            ...(BITDEX_ADMIN_TOKEN ? { Authorization: `Bearer ${BITDEX_ADMIN_TOKEN}` } : {}),
          },
          body: JSON.stringify({ slot_ids: slotIds, ...(fields ? { fields } : {}) }),
          signal: controller.signal,
        })
    );
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`BitDex documents fetch failed ${res.status}: ${errText.slice(0, 500)}`);
    }
    const body = (await res.json()) as { documents?: BitdexDocument[] };
    if (!Array.isArray(body?.documents))
      throw new Error('BitDex documents response missing `documents` array');
    return body.documents;
  } finally {
    clearTimeout(timeout);
  }
}

export interface BitdexQueryResult {
  ids: number[];
  total_matched: number;
  cursor?: any;
  elapsed_us: number;
  documents?: Record<string, unknown>[];
}

/**
 * Query BitDex with pre-built filter clauses and sort.
 * Returns null on any error (never throws).
 *
 * 🔴 THE `null` IS AMBIGUOUS BY CONSTRUCTION, AND `onFailure` IS THE ONLY THING
 * THAT DISAMBIGUATES IT. Missing config, a non-2xx, a thrown fetch, an abort at
 * the deadline and a body that would not parse all return the same `null` as a
 * successful query over an index that genuinely had no match. The caller cannot
 * tell a degraded backend from an empty one, which is why an empty feed page was
 * unalertable (#3930). `onFailure` fires ONLY on the failure half, with the
 * classification made HERE — the one place the status code and the error object
 * are still in scope; once this function returns, that information is gone.
 *
 * Deliberately an OPTIONAL, ADDITIVE last parameter rather than a change of
 * return type. Counting precisely, because two different numbers are true and
 * conflating them has already caused confusion: `queryBitdex` has exactly TWO
 * direct call sites, both in `image.service.ts` (the parallel own-content pass
 * in `fetchBitdexPrimary`, and the one inside `getImagesFromBitdexPreFilter`).
 * The `null` RETURN CONTRACT, however, is interpreted by THREE consumers, because
 * `getImagesFromBitdexPreFilter` is itself re-exported and called from
 * `~/pages/api/internal/bitdex-compare.ts` — so a discriminated union would have
 * rewritten all three, plus every test mock, in the same commit that changes the
 * behaviour, which is precisely the commit you want to be able to read. It
 * reverts by deleting one argument.
 *
 * The callback is for the CALLER's per-request attribution. The per-call counter
 * is emitted here regardless, so a caller that passes nothing still contributes
 * the failure reason.
 *
 * @param includeDocs - true to return all fields, or an array of field names
 * @param onFailure - invoked with the failure classification when this call
 *   returns null for any reason OTHER than a successful empty result. Never
 *   invoked on success. Must not throw; it is called on the feed hot path.
 */
export async function queryBitdex(
  indexName: string,
  filters: FilterClause[],
  sort?: SortClause,
  limit = 100,
  cursor?: any,
  offset?: number,
  includeDocs?: boolean | string[],
  onFailure?: (reason: BitdexQueryFailureReason) => void
): Promise<BitdexQueryResult | null> {
  // Emitting the reason and notifying the caller are one action; splitting them
  // is how one call site ends up counted and another not.
  const fail = (reason: BitdexQueryFailureReason): null => {
    recordBitdexQueryFailure(reason);
    // The callback is caller-supplied. A throw here would convert an already-
    // failed BitDex call into a thrown feed request — strictly worse than the
    // fallback it is reporting.
    try {
      onFailure?.(reason);
    } catch {
      /* instrument-only */
    }
    return null;
  };

  if (!BITDEX_URL) return fail('unconfigured');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), BITDEX_TIMEOUT_MS);
  // Distinguishes a fetch-phase throw from a body-decode throw. Both arrive at
  // the same `catch` with error objects that are not reliably distinguishable by
  // type, and `parse` vs `network` is the difference between "the backend is
  // unreachable" and "the backend answered something we could not read".
  let phase: 'fetch' | 'parse' = 'fetch';
  try {
    const body: any = { filters, limit };
    if (sort) body.sort = sort;
    if (cursor) body.cursor = cursor;
    if (offset != null && offset > 0) body.offset = offset;
    if (includeDocs != null) body.include_docs = includeDocs;

    console.log('[BitDex] query:', JSON.stringify(body));
    const start = Date.now();
    const url = `${BITDEX_URL}/api/indexes/${indexName}/query`;
    const urlAttr = safeUrl(url);
    const res = await withSpan(
      'bitdex:http:fetch',
      {
        'http.method': 'POST',
        'http.url': urlAttr,
        'bitdex.namespace': indexName,
      },
      () =>
        fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal,
        })
    );
    // Cleared EAGERLY here, exactly as before, so the abort deadline still
    // covers the fetch only and not the body decode below. The `finally` is the
    // leak fix, not a widening of the budget: `clearTimeout` on an already-
    // cleared handle is a no-op, so behaviour on this path is unchanged.
    clearTimeout(timeout);
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.error(`[BitDex] Query failed ${res.status} (${Date.now() - start}ms): ${errText.slice(0, 500)}`);
      // 4xx and 5xx are split because they have different owners: a 4xx is
      // almost always something this application sent (the field-the-index-does-
      // not-know case), a 5xx is the backend. A non-2xx below 400 cannot
      // normally occur here (fetch follows redirects) and is classified with the
      // client-error half rather than being invented a seventh label.
      return fail(res.status >= 500 ? 'http_5xx' : 'http_4xx');
    }
    phase = 'parse';
    const result = await withSpan(
      'bitdex:http:parse',
      {
        'http.url': urlAttr,
        'http.status_code': res.status,
        'bitdex.namespace': indexName,
      },
      () => res.json()
    );
    console.log('[BitDex] result:', JSON.stringify({
      ms: Date.now() - start,
      matched: result.total_matched,
      ids: result.ids?.length ?? 0,
      docs: result.documents?.length ?? 0,
      elapsed_us: result.elapsed_us,
    }));
    return result;
  } catch (err) {
    console.error(`[BitDex] Query error:`, err);
    // Duck-typed on `name` rather than `err instanceof Error`. A real abort here
    // is a `DOMException`, and while THIS runtime happens to make DOMException an
    // Error subclass (measured), that is a WebIDL detail we should not be
    // depending on — if it were ever false, every timeout would silently
    // reclassify as `network`, which is the wrong team paged and no error
    // anywhere. The narrowing below cannot throw on null/undefined.
    const aborted = (err as { name?: unknown } | null | undefined)?.name === 'AbortError';
    return fail(aborted ? 'timeout' : phase === 'parse' ? 'parse' : 'network');
  } finally {
    // 🔴 The leak. Before this, the only `clearTimeout` was the eager one above,
    // which a thrown fetch (connection refused, DNS failure, abort) skips
    // entirely — leaving a 30s timer holding the AbortController alive on every
    // failed call, at feed request rate. The sibling `fetchBitdexDocuments`
    // already used `finally` for this reason.
    clearTimeout(timeout);
  }
}
