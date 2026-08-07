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
          headers: { 'Content-Type': 'application/json' },
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
 * @param includeDocs - true to return all fields, or an array of field names
 */
export async function queryBitdex(
  indexName: string,
  filters: FilterClause[],
  sort?: SortClause,
  limit = 100,
  cursor?: any,
  offset?: number,
  includeDocs?: boolean | string[],
): Promise<BitdexQueryResult | null> {
  if (!BITDEX_URL) return null;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), BITDEX_TIMEOUT_MS);
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
    clearTimeout(timeout);
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.error(`[BitDex] Query failed ${res.status} (${Date.now() - start}ms): ${errText.slice(0, 500)}`);
      return null;
    }
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
    return null;
  }
}
