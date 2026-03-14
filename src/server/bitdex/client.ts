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
  | { Not: FilterClause };

export type SortClause = { field: string; direction: 'Asc' | 'Desc' };

const BITDEX_URL = process.env.BITDEX_URL || '';
const BITDEX_TIMEOUT_MS = 30000;

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
    const res = await fetch(`${BITDEX_URL}/api/indexes/${indexName}/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.error(`[BitDex] Query failed ${res.status} (${Date.now() - start}ms): ${errText.slice(0, 500)}`);
      return null;
    }
    const result = await res.json();
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
