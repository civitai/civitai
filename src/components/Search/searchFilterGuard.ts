import { stripQuotedMeiliValues } from '~/components/Search/meili-filter';
import type { SearchClient, SearchRequests } from '~/components/Search/resilientSearchClient';
import {
  createErrorReportCap,
  emptySearchResult,
  pushSearchClientError,
} from '~/components/Search/resilientSearchClient';
import { filterableAttributesByIndex } from '~/server/search-index/filterable-attributes';

/**
 * Drops a search request whose filter names an attribute the TARGET INDEX cannot filter on,
 * before it reaches the network.
 *
 * Why it is needed: `<InstantSearch>` only re-creates its search helper when it is given a
 * `key`. Without one, `react-instantsearch-core` calls `helper.setIndex(indexName).search()`
 * in its RENDER body, and `<InstantSearch>` renders before its children — so a state change
 * that swaps the index fires a search while the helper still carries the PREVIOUS index's
 * `<Configure filters>`. The models filter set then lands on, say, the images index, and the
 * backend answers 400 `invalid_search_filter`. `SearchLayout` avoids this with `key={indexName}`;
 * the dropdown surfaces cannot use that remedy because remounting clears the user's typed query.
 *
 * Behaviour on rejection: the request is NOT sent and resolves to the ordinary empty-result
 * shape — which is exactly what the user already saw, since the backend's 400 is swallowed into
 * an empty dropdown by `createResilientSearchClient`. So there is no UX change.
 *
 * 🔴 It is NOT silent. A rejected request still pushes a Faro RUM error, under a type of its
 * own (`SEARCH_FILTER_GUARD_ERROR_TYPE`) so a locally-rejected request can be told apart from a
 * backend-rejected one (`MEILI_QUERY_ERROR_TYPE`). Some of these events are the only signal a
 * separate index-configuration ticket has; swallowing them would take that ticket dark.
 *
 * 🔴 WHAT IT DOES NOT COVER, because the write-up above would otherwise read as closing the
 * class. This catches exactly the leaks that name an attribute the NEW index cannot filter on —
 * the ones the backend answers with a 400. When the previous target's attributes are all
 * declared on the new index, the stale request is VALID there and is sent: it succeeds, missing
 * whatever clauses the previous target never had to build. That direction produces a 200, so it
 * appears in no error signal at all, and no attribute check can see it — the filters are
 * well-formed, just not the ones this target asked for. `key={indexName}` is what closes both
 * directions; it is not used here because remounting clears the user's typed query.
 *
 * ⚠️ The allow-list is the DESIRED index configuration, not the live one. Meilisearch settings
 * are applied out of band (see `src/pages/api/admin/temp/apply-models-index-filterable-attributes.ts`),
 * so the two can drift either way. `code ⊃ live` is harmless — the guard passes and the backend
 * rejects, exactly as today. `live ⊃ code` is the one to watch: removing an attribute from
 * `filterable-attributes.ts` that the live index still declares turns a working query into a
 * silently empty result set.
 *
 * Scope: `search` only. `searchForFacetValues` can 400 the same way, but no surface wired to
 * this guard uses it — add a `facetName` check here if one ever does.
 */

type SearchRequest = SearchRequests[number];

/**
 * Faro exception `type` and console prefix for a request this guard refused to send. One token
 * so a log query and a `grep` of a browser console find the same thing, and deliberately NOT
 * `MEILI_QUERY_ERROR_TYPE` — that one means the backend answered and rejected us.
 *
 * 🔴 A population that used to beacon as `MEILI_QUERY_ERROR_TYPE` now beacons as this instead:
 * a filter aimed at the wrong index no longer reaches the backend, so it no longer produces a
 * backend rejection. Any saved query watching the old token for THAT population will read zero
 * and look fixed. See `~/utils/faro/classifyException` for how the type is handled — it matches
 * no rule there, so the beacon is kept and tagged `error_category: real`, same as its sibling.
 */
export const SEARCH_FILTER_GUARD_ERROR_TYPE = 'SearchFilterAttributeError';

/**
 * Filter-grammar words that can sit where an attribute sits. `true`/`false` are values, the rest
 * are operators/connectives; none is a real attribute on any index.
 */
const RESERVED_WORDS = new Set([
  'and',
  'or',
  'not',
  'to',
  'in',
  'exists',
  'is',
  'null',
  'empty',
  'contains',
  'starts',
  'with',
  'true',
  'false',
]);

// An attribute is whatever sits immediately left of an operator. Each pattern opens with
// `(^|[^\w.])` rather than a lookbehind, for two reasons: lookbehind is unsupported on older
// Safari and a SyntaxError here would break search outright there; and requiring a non-word,
// non-dot character makes every start position inside a long identifier run fail in O(1), which
// is what keeps the scan linear on a pasted multi-kilobyte query rather than quadratic.
//
// 🔴 These are module-scope `/g` objects, so `lastIndex` is shared state. That is safe only
// while every consumer of `collectFromExpression` is SYNCHRONOUS — there is no `await` and no
// callback between the reset and the terminating `null`, and `withSearchFilterGuard` classifies
// a whole batch before its first `await`. Do not make this collection async.
const COMPARISON_OPERAND = /(^|[^\w.])([A-Za-z_][A-Za-z0-9_.]*)\s*(?:>=|<=|!=|=|>|<)/g;
const KEYWORD_OPERAND =
  /(^|[^\w.])([A-Za-z_][A-Za-z0-9_.]*)\s+(?:NOT\s+IN|IN|EXISTS|IS\s+(?:NULL|EMPTY)|CONTAINS|STARTS\s+WITH)\b/gi;
// `attr 1 TO 10` — the only form where the attribute is not adjacent to its operator.
const RANGE_OPERAND = /(^|[^\w.])([A-Za-z_][A-Za-z0-9_.]*)\s+-?\d+(?:\.\d+)?\s+TO\s/gi;

function collectFromExpression(value: unknown, out: string[]): void {
  if (Array.isArray(value)) {
    for (const entry of value) collectFromExpression(entry, out);
    return;
  }
  if (typeof value !== 'string' || !value.trim()) return;

  const expression = stripQuotedMeiliValues(value);
  for (const pattern of [COMPARISON_OPERAND, KEYWORD_OPERAND, RANGE_OPERAND]) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(expression)) !== null) {
      const attribute = match[2];
      if (attribute && !RESERVED_WORDS.has(attribute.toLowerCase())) out.push(attribute);
    }
  }
}

/** `facetFilters` entries are `attribute:value` (or `attribute:-value`), nested up to 2 deep. */
function collectFromFacetFilters(value: unknown, out: string[]): void {
  if (Array.isArray(value)) {
    for (const entry of value) collectFromFacetFilters(entry, out);
    return;
  }
  if (typeof value !== 'string') return;
  const separator = value.indexOf(':');
  if (separator > 0) out.push(value.slice(0, separator));
}

/** `facets` are plain attribute names; `*` asks for all of them and names none. */
function collectFromFacets(value: unknown, out: string[]): void {
  if (Array.isArray(value)) {
    for (const entry of value) collectFromFacets(entry, out);
    return;
  }
  if (typeof value === 'string' && value && value !== '*') out.push(value);
}

/**
 * Every attribute a request's params ask the backend to filter or facet on.
 *
 * 🔴 No collector may ever emit the empty string. No index declares `''`, so one would reject
 * the whole request — and this guard has to fail OPEN on malformed input, never closed. Each
 * collector holds that itself; a second `.filter(Boolean)` here was tried and removed, because
 * a redundant outer guard makes the real ones untestable (every mutation of them dies to the
 * outer filter instead, so the suite stays green with the actual protection deleted).
 */
export function collectFilterAttributes(params: unknown): string[] {
  const record = (params ?? {}) as Record<string, unknown>;
  const out: string[] = [];
  collectFromExpression(record.filters, out);
  collectFromExpression(record.numericFilters, out);
  collectFromFacetFilters(record.facetFilters, out);
  collectFromFacets(record.facets, out);
  return [...new Set(out)];
}

/**
 * The attributes a request asks for that a given declaration does not cover.
 *
 * Declaring a parent attribute makes its sub-fields filterable in the engine, so `user`
 * covers `user.id` — the dot matters: `user` must not cover `username`. No index declares a
 * bare parent today; the rule is here so that adding one does not start rejecting valid
 * queries, and it is exercised directly rather than through `filterableAttributesByIndex`,
 * which cannot currently reach it.
 */
export function unsupportedAttributes(declared: readonly string[], params: unknown): string[] {
  const exact = new Set(declared);
  return collectFilterAttributes(params).filter(
    (attribute) =>
      !exact.has(attribute) && !declared.some((parent) => attribute.startsWith(`${parent}.`))
  );
}

/**
 * The attributes this request asks for that its index does not declare filterable.
 *
 * Deliberately fails OPEN: an index we hold no declaration for returns `[]`, so a new or
 * externally-configured index is never blocked by a stale list.
 */
export function findUnsupportedFilterAttributes(indexName: unknown, params: unknown): string[] {
  if (typeof indexName !== 'string' || !indexName) return [];
  const filterable = filterableAttributesByIndex[
    indexName as keyof typeof filterableAttributesByIndex
  ] as readonly string[] | undefined;
  if (!filterable) return [];

  return unsupportedAttributes(filterable, params);
}

/** Carries the index and the offending attribute names, never the user's query. */
function reportRejection(indexName: string, attributes: string[]) {
  const message = `Search filter attributes not filterable on "${indexName}": ${attributes.join(
    ', '
  )}`;

  pushSearchClientError(
    new Error(message),
    SEARCH_FILTER_GUARD_ERROR_TYPE,
    { indexes: indexName, attributes: attributes.join(',') },
    message,
    { indexName, attributes }
  );
}

/**
 * Wrap a search client so a request whose filters cannot apply to its index resolves to empty
 * results instead of being sent. Requests in the same batch that ARE valid still go to the
 * backend, and their responses are returned in their original positions, with every sibling
 * field of the response preserved.
 */
export function withSearchFilterGuard<T extends SearchClient>(client: T): T {
  const shouldReport = createErrorReportCap();

  const guardedSearch = async (requests: SearchRequests) => {
    const list = (requests ?? []) as readonly SearchRequest[];
    const rejected = new Map<number, string[]>();

    list.forEach((request, index) => {
      const indexName = (request as { indexName?: unknown })?.indexName;
      const attributes = findUnsupportedFilterAttributes(
        indexName,
        (request as { params?: unknown })?.params
      );
      if (attributes.length) rejected.set(index, attributes);
    });

    if (rejected.size === 0) return client.search(requests);

    for (const [index, attributes] of rejected) {
      const indexName = String((list[index] as { indexName?: unknown })?.indexName ?? '');
      if (!shouldReport(`${indexName}|${[...attributes].sort().join(',')}`)) continue;
      reportRejection(indexName, attributes);
    }

    const survivors = list.filter((_, index) => !rejected.has(index));
    if (survivors.length === 0) {
      return { results: list.map(() => emptySearchResult()) };
    }

    const response = (await client.search(survivors as SearchRequests)) as {
      results?: unknown[];
    };
    let cursor = 0;
    const results = list.map((_, index) =>
      rejected.has(index)
        ? emptySearchResult()
        : response?.results?.[cursor++] ?? emptySearchResult()
    );
    return { ...response, results };
  };

  // Same cast-at-the-boundary reason as `createResilientSearchClient`: the library's `search`
  // is generic over the hit type and a concrete wrapper that awaits the result cannot preserve
  // that variance. Runtime behaviour is generic-transparent — either the base client's response
  // verbatim, or a valid empty response of the same arity.
  return { ...client, search: guardedSearch } as unknown as T;
}
