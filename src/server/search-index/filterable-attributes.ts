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
  // Carried so a filter can split the labeled tier from the unlabeled one — which is what
  // the pre-registered gold-set study needs to compare a purpose-query arm against a
  // popularity arm over the slice where labels actually exist (~1.1% of documents).
  // Verified on Meilisearch v1.15.0 that filtering works on this field even though
  // ./displayed-attributes.ts withholds it.
  //
  // 🔴 THE PREDICATE IS `IS NOT NULL` / `IS NULL`, **NOT** `EXISTS` / `NOT EXISTS`, and an
  // earlier version of this comment named the wrong pair. `models.search-index.ts` WRITES
  // `insight: { qualityScore: null }` on every unlabeled model (it must — omitting the key
  // cannot clear a stale score under PUT merge semantics; see that file). A written null
  // COUNTS AS EXISTING, so once a reset has written every document:
  //   EXISTS       -> every document          (useless as a labeled-tier arm)
  //   NOT EXISTS   -> nothing at all          (useless as a control arm)
  //   IS NOT NULL  -> the labeled tier        <- use this
  //   IS NULL      -> the unlabeled remainder <- and this
  // Measured on v1.15.0 over a mixed fixture (labeled / written-null / key-absent): EXISTS
  // returned 5 of 7 including every written null, NOT EXISTS returned only the 2 whose key
  // was absent, and `IS NOT NULL` returned the labeled rows plus the key-absent ones — which
  // is why the pair above is only correct once every document carries the key, i.e. AFTER a
  // full reset. Before then, no single predicate isolates the labeled set.
  //
  // ⚠ Added in the SAME change as the sortable entry, and the reason first given for that
  // was WRONG: it said "both lists are written only by `onIndexSetup` from `reset()`".
  // That holds for `sortableAttributes` and NOT for this list —
  // src/pages/api/admin/temp/apply-models-index-filterable-attributes.ts applies THIS list
  // to the live index with no reset, and there is no sortable equivalent of that route.
  //
  // The decision stands on the corrected argument: a reset writes both lists into the
  // `_NEW` index at setup, so riding the reset this change already requires is FREE,
  // whereas deferring it means paying that route's own full facet rebuild later. So the
  // asymmetry is a reason to land it now, not a reason the claim was harmless.
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
