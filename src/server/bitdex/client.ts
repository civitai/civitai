import { translateFilters, translateSort, type FilterClause, type SortClause } from './filter-translator';

const BITDEX_URL = process.env.BITDEX_URL || '';
const BITDEX_DEFAULT_INDEX = 'civitai';
const BITDEX_TIMEOUT_MS = 30000;

export interface BitdexQueryResult {
  ids: number[];
  total_matched: number;
  cursor?: any;
  elapsed_us: number;
}

/**
 * Query BitDex with pre-built filter clauses and sort.
 * Returns null on any error (never throws).
 */
export async function queryBitdex(
  indexName: string,
  filters: FilterClause[],
  sort?: SortClause,
  limit = 100,
  cursor?: any,
  offset?: number,
): Promise<BitdexQueryResult | null> {
  if (!BITDEX_URL) return null;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), BITDEX_TIMEOUT_MS);
    const body: any = { filters, limit };
    if (sort) body.sort = sort;
    if (cursor) body.cursor = cursor;
    if (offset != null && offset > 0) body.offset = offset;

    const res = await fetch(`${BITDEX_URL}/api/indexes/${indexName}/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.error(`[BitDex] Query failed ${res.status}: ${errText.slice(0, 500)}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.error(`[BitDex] Query error:`, err);
    return null;
  }
}

/**
 * Upsert documents to BitDex. Fails silently (returns 0 on error).
 */
export async function upsertBitdexDocuments(
  indexName: string,
  documents: any[],
): Promise<number> {
  if (!BITDEX_URL || documents.length === 0) return 0;
  try {
    const res = await fetch(`${BITDEX_URL}/api/indexes/${indexName}/documents/upsert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ documents }),
    });
    if (!res.ok) return 0;
    const data = await res.json();
    return data.upserted ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Delete documents from BitDex. Fails silently (returns 0 on error).
 */
export async function deleteBitdexDocuments(
  indexName: string,
  ids: number[],
): Promise<number> {
  if (!BITDEX_URL || ids.length === 0) return 0;
  try {
    const res = await fetch(`${BITDEX_URL}/api/indexes/${indexName}/documents`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    });
    if (!res.ok) return 0;
    const data = await res.json();
    return data.deleted ?? 0;
  } catch {
    return 0;
  }
}

/**
 * High-level: query BitDex using the same inputs as Meilisearch.
 * Translates Meilisearch filter strings + sort to BitDex format.
 * Returns the result or null on error (for shadow mode comparison).
 */
export async function getImagesFromBitdex(
  meiliFilters: string | string[],
  meiliSort: string | undefined,
  limit: number,
  cursor?: any,
  offset?: number,
): Promise<BitdexQueryResult | null> {
  const filters = translateFilters(meiliFilters);
  const sort = meiliSort ? translateSort(meiliSort) : undefined;
  return queryBitdex(BITDEX_DEFAULT_INDEX, filters, sort, limit, cursor, offset);
}
