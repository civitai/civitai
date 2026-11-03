import type { SiteSearchParams } from '~/server/schema/site-search.schema';
import { modelsFilterableAttributes } from '~/server/search-index/filterable-attributes';
import { parseMeiliFilter, UnsupportedSearchRequest } from '~/server/search/meili-filter';
import { compileClauses, fieldResolver } from '~/server/search/opensearch/compile-clauses';
import type {
  OpenSearchClient,
  OpenSearchSearchResponse,
} from '~/server/search/opensearch/opensearch-client';

// Answers a models search the site's UI wrote for Meilisearch from OpenSearch, in Meilisearch's
// response shape, so the existing UI can be served by either engine during the comparison.

/** Meilisearch never returns more than this many hits for a query; the UI pages within it. */
const MAX_TOTAL_HITS = 1000;
const DEFAULT_LIMIT = 20;

// Filters are case-insensitive in Meilisearch: string attributes filter on a lowercased subfield.
const CASE_INSENSITIVE_FIELDS: Record<string, string> = {
  'user.username': 'user.username.raw',
  'tags.name': 'tags.name.ci',
  'category.name': 'category.name.ci',
  type: 'type.ci',
  checkpointType: 'checkpointType.ci',
  'version.baseModel': 'version.baseModel.ci',
  'versions.baseModel': 'versions.baseModel.ci',
};
const resolveFilterField = fieldResolver(
  Object.fromEntries(modelsFilterableAttributes.map((a) => [a, CASE_INSENSITIVE_FIELDS[a] ?? a]))
);

/** Facets count exact values, so the UI's labels and refinements keep their case. */
const FACET_FIELDS: Record<string, string> = {
  type: 'type',
  checkpointType: 'checkpointType',
  'tags.name': 'tags.name',
  'category.name': 'category.name',
  'version.baseModel': 'version.baseModel',
  'versions.baseModel': 'versions.baseModel',
  'user.username': 'user.username.exact',
  fileFormats: 'fileFormats',
  nsfwLevel: 'nsfwLevel',
  lastVersionAtUnix: 'lastVersionAtUnix',
};
const NUMERIC_FACETS = new Set(['nsfwLevel', 'lastVersionAtUnix']);

/**
 * Sorts the UI can ask for. The visible `metrics.*` numbers are masked when a creator hides them,
 * so sorting reads the real ones in `ranking`. `null` = no field holds it: no models document has
 * ever carried a favorite count, so Meilisearch answers that sort in relevance order, and so does
 * this.
 */
const SORT_FIELDS: Record<string, string | null> = {
  'metrics.thumbsUpCount': 'ranking.thumbsUpCount',
  'metrics.downloadCount': 'ranking.downloadCount',
  'metrics.commentCount': 'ranking.commentCount',
  'metrics.collectedCount': 'ranking.collectedCount',
  'metrics.tippedAmountCount': 'ranking.tippedAmountCount',
  'metrics.favoriteCount': null,
  'sortMetrics.downloadCount': 'ranking.downloadCount',
  'sortMetrics.tippedAmountCount': 'ranking.tippedAmountCount',
  'insight.qualityScore': 'insight.qualityScore',
  createdAt: 'createdAt',
  lastVersionAtUnix: 'lastVersionAtUnix',
  id: 'id',
};

function sortClauses(sort: string[] | undefined) {
  const clauses: object[] = [];
  for (const entry of sort ?? []) {
    const [attribute, direction = 'asc'] = entry.split(':');
    if (!(attribute in SORT_FIELDS) || !['asc', 'desc'].includes(direction))
      throw new UnsupportedSearchRequest(`unsupported sort ${entry}`);
    const field = SORT_FIELDS[attribute];
    if (field) clauses.push({ [field]: { order: direction, missing: '_last' } });
  }
  return clauses;
}

function textQuery(q: string) {
  const lower = q.toLowerCase();
  const should: object[] = [
    { term: { hashes: { value: lower, boost: 20 } } },
    { term: { 'name.raw': { value: lower, boost: 10 } } },
    { prefix: { 'name.raw': { value: lower, boost: 12 } } },
    { match_phrase: { name: { query: q, boost: 6 } } },
    { match_phrase_prefix: { name: { query: q, boost: 6 } } },
    {
      multi_match: {
        query: q,
        // Both titles, as decided 2026-10-22: each site returns the hit under its own title.
        fields: ['name^4', 'sfwName^4', 'name.prefix^2', 'user.username^2', 'triggerWords'],
        type: 'most_fields',
        operator: 'and',
        fuzziness: 'AUTO:5,9',
        prefix_length: 1,
      },
    },
    { term: { 'user.username.raw': { value: lower, boost: 8 } } },
  ];
  // Meilisearch drops trailing words when all of them cannot match; a weak any-word match keeps
  // longer queries from coming back empty, ranked below every full match.
  if (q.trim().includes(' '))
    should.push({
      multi_match: {
        query: q,
        fields: ['name^2', 'triggerWords'],
        operator: 'or',
        minimum_should_match: '2<-34%',
        boost: 0.3,
      },
    });
  return {
    function_score: {
      query: { bool: { should, minimum_should_match: 1 } },
      functions: [
        { field_value_factor: { field: 'ranking.thumbsUpCount', modifier: 'sqrt', missing: 0 } },
        { filter: { term: { isOfficial: true } }, weight: 5 },
      ],
      score_mode: 'multiply',
      boost_mode: 'multiply',
    },
  };
}

type Paging =
  | { mode: 'offset'; offset: number; limit: number }
  | { mode: 'page'; page: number; hitsPerPage: number };

function paging(params: SiteSearchParams): Paging {
  if (params.hitsPerPage !== undefined || params.page !== undefined)
    return {
      mode: 'page',
      page: Math.max(1, params.page ?? 1),
      hitsPerPage: params.hitsPerPage ?? DEFAULT_LIMIT,
    };
  return { mode: 'offset', offset: params.offset ?? 0, limit: params.limit ?? DEFAULT_LIMIT };
}

/**
 * The OpenSearch request for a Meilisearch-shaped models search. `filters` are the client's filter
 * plus the viewer's clauses, in Meilisearch filter syntax. Throws `UnsupportedSearchRequest` for
 * anything it cannot answer the way Meilisearch would.
 */
export function buildModelsSearchRequest(params: SiteSearchParams, filters: (string | string[])[]) {
  const q = params.q?.trim() ?? '';
  const page = paging(params);
  const from = page.mode === 'offset' ? page.offset : (page.page - 1) * page.hitsPerPage;
  const size = page.mode === 'offset' ? page.limit : page.hitsPerPage;
  const clampedSize = Math.max(0, Math.min(size, MAX_TOTAL_HITS - from));

  const sort = sortClauses(params.sort);
  if (q) sort.push({ _score: { order: 'desc' } });
  // With no text, Meilisearch orders by its ranking rules: official models, then likes.
  else sort.push({ isOfficial: { order: 'desc' } }, { 'ranking.thumbsUpCount': { order: 'desc' } });
  sort.push({ id: { order: 'desc' } });

  const aggs: Record<string, object> = {};
  for (const facet of params.facets ?? []) {
    const field = FACET_FIELDS[facet];
    if (!field) throw new UnsupportedSearchRequest(`unsupported facet ${facet}`);
    aggs[`facet:${facet}`] = { terms: { field, size: 250 } };
    if (NUMERIC_FACETS.has(facet)) {
      aggs[`min:${facet}`] = { min: { field } };
      aggs[`max:${facet}`] = { max: { field } };
    }
  }

  const retrieve = params.attributesToRetrieve;
  const highlight = !!q && !!params.attributesToHighlight?.length;
  return {
    paging: page,
    highlight,
    body: {
      from: Math.min(from, MAX_TOTAL_HITS),
      size: clampedSize,
      track_total_hits: MAX_TOTAL_HITS,
      _source: retrieve && !retrieve.includes('*') ? retrieve : true,
      query: {
        bool: {
          must: q ? textQuery(q) : { match_all: {} },
          filter: compileClauses(parseMeiliFilter(filters), resolveFilterField),
        },
      },
      sort,
      ...(Object.keys(aggs).length ? { aggs } : {}),
      ...(highlight
        ? {
            highlight: {
              pre_tags: [params.highlightPreTag ?? '<em>'],
              post_tags: [params.highlightPostTag ?? '</em>'],
              fields: {
                name: { number_of_fragments: 0 },
                sfwName: { number_of_fragments: 0 },
              },
            },
          }
        : {}),
    },
  };
}

/** An OpenSearch answer in the shape Meilisearch gives the UI. */
export function toMeiliSearchResponse(
  request: ReturnType<typeof buildModelsSearchRequest>,
  params: SiteSearchParams,
  response: OpenSearchSearchResponse
) {
  const total = Math.min(response.hits.total.value, MAX_TOTAL_HITS);
  const hits = response.hits.hits.map((hit) => {
    const source = { ...hit._source };
    if (!request.highlight) return source;
    const name = hit.highlight?.name?.[0];
    const sfwName = hit.highlight?.sfwName?.[0];
    return {
      ...source,
      _formatted: { ...source, ...(name ? { name } : {}), ...(sfwName ? { sfwName } : {}) },
    };
  });

  const facetDistribution: Record<string, Record<string, number>> = {};
  const facetStats: Record<string, { min: number; max: number }> = {};
  for (const facet of params.facets ?? []) {
    const aggs = response.aggregations ?? {};
    facetDistribution[facet] = Object.fromEntries(
      (aggs[`facet:${facet}`]?.buckets ?? []).map((b) => [String(b.key), b.doc_count])
    );
    const min = aggs[`min:${facet}`]?.value;
    const max = aggs[`max:${facet}`]?.value;
    if (typeof min === 'number' && typeof max === 'number') facetStats[facet] = { min, max };
  }

  const paging =
    request.paging.mode === 'offset'
      ? {
          offset: request.paging.offset,
          limit: request.paging.limit,
          estimatedTotalHits: total,
        }
      : {
          page: request.paging.page,
          hitsPerPage: request.paging.hitsPerPage,
          totalHits: total,
          totalPages: request.paging.hitsPerPage
            ? Math.ceil(total / request.paging.hitsPerPage)
            : 0,
        };

  return {
    hits,
    query: params.q ?? '',
    processingTimeMs: response.took,
    ...paging,
    ...(params.facets?.length ? { facetDistribution, facetStats } : {}),
  };
}

export async function searchModelsOnOpenSearch(
  client: OpenSearchClient,
  index: string,
  params: SiteSearchParams,
  filters: (string | string[])[]
) {
  const request = buildModelsSearchRequest(params, filters);
  const response = await client.search(index, request.body);
  return toMeiliSearchResponse(request, params, response);
}
