import type { dbRead } from '~/server/db/client';
import type { SearchIndexContext } from '~/server/search-index/base.search-index';
import { modelSearchIndexEligibilitySql } from '~/server/search-index/model-index-eligibility';
import { MODELS_WITHHELD_ATTRIBUTES } from '~/server/search-index/displayed-attributes';
import { pullModelsData, transformModelsData } from '~/server/search-index/models.search-index';
import type { IndexDefinition, IndexSource } from '~/server/search/opensearch/index-build';
import { MODELS_INDEX_ALIAS } from '~/server/search/opensearch/indexes';
import { toModelDocuments } from '~/server/search/opensearch/models-mirror';

/**
 * The models documents, built by the same pull and transform as the Meilisearch models index so
 * the two cannot drift.
 */
export function createModelsIndexSource({ db }: { db: typeof dbRead }): IndexSource {
  return {
    async nextIds(afterId, limit) {
      const rows = await db.$queryRaw<{ id: number }[]>`
        SELECT m.id FROM "Model" m
        WHERE ${modelSearchIndexEligibilitySql()} AND m.id > ${afterId}
        ORDER BY m.id
        LIMIT ${limit}
      `;
      return rows.map((row) => row.id);
    },

    async buildDocuments(ids) {
      if (!ids.length) return new Map();
      // The models pull reads only `db` and `logger` from its context.
      const context = { db, indexName: MODELS_INDEX_ALIAS, logger: () => undefined };
      const pulled = await pullModelsData(context as SearchIndexContext, { type: 'update', ids });
      return toModelDocuments(await transformModelsData(pulled));
    },

    async changedSince(since) {
      // Every status, not just eligible ones: a model unpublished during the build must be
      // removed, and the eligibility filter would hide it.
      const rows = await db.$queryRaw<{ id: number }[]>`
        SELECT m.id FROM "Model" m WHERE m."updatedAt" >= ${since} ORDER BY m.id
      `;
      return rows.map((row) => row.id);
    },
  };
}

const keyword = { type: 'keyword' } as const;
const integer = { type: 'integer' } as const;
const text = { type: 'text', analyzer: 'name_text' } as const;
const lowercaseKeyword = { type: 'keyword', normalizer: 'lowercase_norm' } as const;
/** Exact values for facets, plus `.ci` for case-insensitive filters, as Meilisearch filters are. */
const facetKeyword = { type: 'keyword', fields: { ci: lowercaseKeyword } } as const;

/** Fields that are indexed for filtering and ranking but never stored, so never returned. */
export const MODELS_UNSTORED_FIELDS = ['ranking', ...MODELS_WITHHELD_ATTRIBUTES];

// Only these fields are indexed; the rest of each document is stored (`dynamic: false`) and comes
// back with a hit. Field paths match the Meilisearch models index, so filters carry over.
export const modelsIndexDefinition: IndexDefinition = {
  settings: {
    number_of_shards: 1,
    analysis: {
      normalizer: { lowercase_norm: { type: 'custom', filter: ['lowercase', 'asciifolding'] } },
      analyzer: {
        // Model names look like "ponyDiffusionV6XL" or "SDXL_Lightning-4step": split on case
        // changes, digits and punctuation, and keep the original token too.
        name_text: { tokenizer: 'standard', filter: ['name_split', 'lowercase', 'asciifolding'] },
        name_prefix: {
          tokenizer: 'standard',
          filter: ['name_split', 'lowercase', 'asciifolding', 'edge_2_20'],
        },
      },
      filter: {
        name_split: { type: 'word_delimiter_graph', preserve_original: true },
        edge_2_20: { type: 'edge_ngram', min_gram: 2, max_gram: 20 },
      },
    },
  },
  mappings: {
    dynamic: false,
    _source: { excludes: MODELS_UNSTORED_FIELDS },
    properties: {
      id: integer,
      name: {
        ...text,
        fields: {
          prefix: { type: 'text', analyzer: 'name_prefix', search_analyzer: 'name_text' },
          raw: lowercaseKeyword,
        },
      },
      sfwName: text,
      user: {
        properties: {
          id: integer,
          username: { ...text, fields: { raw: lowercaseKeyword, exact: keyword } },
        },
      },
      hashes: lowercaseKeyword,
      triggerWords: text,
      isOfficial: { type: 'boolean' },
      type: facetKeyword,
      status: keyword,
      availability: keyword,
      checkpointType: facetKeyword,
      fileFormats: keyword,
      nsfwLevel: integer,
      poi: { type: 'boolean' },
      minor: { type: 'boolean' },
      canGenerate: { type: 'boolean' },
      canGenerateNext: { type: 'boolean' },
      cannotPromote: { type: 'boolean' },
      hasActivePaidAccess: { type: 'boolean' },
      createdAt: { type: 'date' },
      lastVersionAtUnix: { type: 'long' },
      tags: { properties: { name: facetKeyword } },
      category: { properties: { name: facetKeyword } },
      version: { properties: { baseModel: facetKeyword } },
      versions: {
        properties: {
          id: integer,
          baseModel: facetKeyword,
          hashes: lowercaseKeyword,
          canGenerateNext: { type: 'boolean' },
          generatorLoaded: { type: 'boolean' },
          turbo: { type: 'boolean' },
          pricing: keyword,
        },
      },
      insight: {
        properties: { qualityScore: { type: 'float' }, role: keyword, styleFamily: keyword },
      },
      ranking: {
        properties: {
          thumbsUpCount: integer,
          downloadCount: integer,
          commentCount: integer,
          collectedCount: integer,
          tippedAmountCount: integer,
        },
      },
    },
  },
};
