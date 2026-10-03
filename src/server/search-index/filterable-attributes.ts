import {
  ARTICLES_SEARCH_INDEX,
  BOUNTIES_SEARCH_INDEX,
  COLLECTIONS_SEARCH_INDEX,
  COMICS_SEARCH_INDEX,
  IMAGES_SEARCH_INDEX,
  MODELS_SEARCH_INDEX,
  TOOLS_SEARCH_INDEX,
  USERS_SEARCH_INDEX,
} from '~/server/common/constants';

// Kept a leaf so a test can read these without loading `~/server/meilisearch/client`, which builds
// pLimit/prom collectors at module load.

// `id` is filterable on every index because the keyset cleanup scan in
// src/server/meilisearch/cleanup.ts pages on it.
export const articlesFilterableAttributes = ['id', 'tags.name', 'user.username', 'nsfwLevel'];

export const bountiesFilterableAttributes = [
  'id',
  'user.username',
  'type',
  'details.baseModel',
  'tags.name',
  'complete',
  'nsfwLevel',
];

export const collectionsFilterableAttributes = ['user.username', 'type', 'nsfwLevel', 'id'];

export const comicsFilterableAttributes = ['id', 'user.username', 'genre', 'nsfwLevel'];

export const imagesFilterableAttributes = [
  'id',
  'createdAtUnix',
  'tagNames',
  'user.username',
  'baseModel',
  'aspectRatio',
  'nsfwLevel',
  'type',
  'toolNames',
  'techniqueNames',
  'flags.promptNsfw',
  'poi',
  'minor',
];

export const modelsFilterableAttributes = [
  'availability',
  'canGenerate',
  'canGenerateNext',
  'category.name',
  'checkpointType',
  'fileFormats',
  'hashes',
  'id',
  'lastVersionAtUnix',
  'nsfwLevel',
  'status',
  'tags.name',
  'type',
  'user.id',
  'user.username',
  'version.baseModel',
  'versions.baseModel',
  'versions.canGenerateNext',
  'versions.generatorLoaded',
  'versions.hashes',
  'versions.id',
  'versions.pricing',
  'cannotPromote',
  'poi',
  'minor',
  'hasActivePaidAccess',
  // Carried so a `insight.qualityScore EXISTS` / `NOT EXISTS` filter can split the
  // labeled tier from the unlabeled one — which is what the pre-registered gold-set
  // study needs to compare a purpose-query arm against a popularity arm over the slice
  // where labels actually exist (~1.1% of documents). Verified on Meilisearch v1.15.0
  // that EXISTS works on this field even though ./displayed-attributes.ts withholds it.
  //
  // Added in the SAME change as the sortable entry on purpose: `filterableAttributes`
  // genuinely rebuilds facet data (unlike `displayedAttributes`, measured at 6.4 ms on
  // 718,383 documents), and both lists are written only by `onIndexSetup` from
  // `reset()`. Landing them together means one reset covers the sort and the study.
  'insight.qualityScore',
];

export const toolsFilterableAttributes = ['id', 'type', 'company'];

export const usersFilterableAttributes = ['id', 'username'];

export const filterableAttributesByIndex = {
  [ARTICLES_SEARCH_INDEX]: articlesFilterableAttributes,
  [BOUNTIES_SEARCH_INDEX]: bountiesFilterableAttributes,
  [COLLECTIONS_SEARCH_INDEX]: collectionsFilterableAttributes,
  [COMICS_SEARCH_INDEX]: comicsFilterableAttributes,
  [IMAGES_SEARCH_INDEX]: imagesFilterableAttributes,
  [MODELS_SEARCH_INDEX]: modelsFilterableAttributes,
  [TOOLS_SEARCH_INDEX]: toolsFilterableAttributes,
  [USERS_SEARCH_INDEX]: usersFilterableAttributes,
} as const;
