// Kept a leaf so a test and the admin apply route can read this without loading
// `~/server/meilisearch/client`, which builds pLimit/prom collectors at module load. Same
// reasoning as ./filterable-attributes.ts and ./sortable-attributes.ts.

// 🔴 This list is a PRIVACY BOUNDARY, not a convenience. Creator Controls lets a creator hide
// their buzz/download/generation numbers; `metrics.*` is masked for them, but `sortMetrics` holds
// the REAL values because Meilisearch can only sort on a stored field. Meili returns every stored
// attribute unless `displayedAttributes` narrows it, so this whitelist is the ONLY thing keeping a
// masked creator's true numbers out of a search hit.
//
// Meili whitelists by TOP-LEVEL attribute and nested children ride along with their parent, so
// only NEW top-level document keys need adding here. That is why `versions.canGenerateNext` keeps
// being returned while top-level `canGenerateNext` does not: `versions` is listed.
//
// 🔴 Adding `sortMetrics` here re-opens the leak. `src/server/__tests__/models-displayed-attributes.test.ts`
// pins its absence; do not "fix" that test by listing it.
//
// Two separate writers apply this to a live index, and they must stay in agreement — which is why
// the list lives here rather than inside either of them:
//   - `onIndexSetup` in ./models.search-index.ts, reached only by `reset()` against `<index>_NEW`
//   - `src/pages/api/admin/temp/apply-models-index-displayed-attributes.ts`, the only way to
//     apply it to the LIVE index without a full rebuild
export const modelsDisplayedAttributes = [
  'id',
  'name',
  'type',
  'nsfw',
  'nsfwLevel',
  'minor',
  'sfwOnly',
  'status',
  'createdAt',
  'lastVersionAt',
  'lastVersionAtUnix',
  'publishedAt',
  'locked',
  'earlyAccessDeadline',
  'hasActivePaidAccess',
  'mode',
  'checkpointType',
  'availability',
  'poi',
  'user',
  'category',
  'permissions',
  'version',
  'versions',
  'triggerWords',
  'fileFormats',
  'hashes',
  'tags',
  'metrics',
  'rank',
  'hiddenMetrics',
  'canGenerate',
  'cannotPromote',
  'cosmetic',
  'images',
];

// Attributes a document may carry that this list deliberately WITHHOLDS. Sort-only or
// filter-only fields: Meilisearch sorts and filters on the stored document regardless of
// `displayedAttributes`, so withholding them costs no functionality.
//
// There is no `displayedAttributesByIndex` sibling map because `models_v9` is the only index whose
// `onIndexSetup` narrows this setting at all; every other index runs Meili's `["*"]` default.
export const MODELS_WITHHELD_ATTRIBUTES = [
  // The Creator Controls leak above. Sort-only.
  'sortMetrics',
  // Filter-only: `coverage-fields.ts` builds `eq('canGenerateNext', true)`. The per-version copy
  // the client actually reads is `versions.canGenerateNext`, which rides along with `versions`.
  'canGenerateNext',
  // In neither `modelsFilterableAttributes` nor `modelsSortableAttributes`, and read by no search
  // consumer — `resource-select.service.ts` reads `isOfficial` from the DB, not from a hit.
  'isOfficial',
  // Written by the OTHER writer into this same index: `src/pages/api/mod/search/models-update.ts`
  // pushes `{ id, flags }`, so `flags` is a top-level key this list must account for even though
  // `models.search-index.ts` never emits it. No models filterable entry references it
  // (`flags.promptNsfw` belongs to `imagesFilterableAttributes`) and no consumer reads it off a hit.
  'flags',
];

// 🔴 FROZEN, and this is the deterministic half of the guard — not decoration.
//
// Removing the local copy in `models.search-index.ts` closed ONE mutation shape and the comment
// there claimed it closed the class. It did not: this export is a plain array handed out BY
// REFERENCE, so `modelsDisplayedAttributes.push('sortMetrics')` anywhere in the process re-opens
// the leak in one line — measured, and it passed the entire suite. Worse than the local copy it
// replaced, because a mutation here also contaminates the admin route's `desired`.
//
// Frozen, that push throws instead of silently widening a privacy boundary. `Array.prototype.push`
// on a non-extensible object throws on its own account, strict mode or not; strict mode is what
// additionally makes a bracket assignment (`arr[0] = 'x'`) throw rather than silently no-op.
//
// `models-displayed-attributes.test.ts` asserts the freeze is still in place, so it cannot be
// removed quietly, and asks the TypeScript parser whether any non-test file mutates this array in
// place — so the attempt is caught at review rather than at runtime.
//
// Note the house style this cuts against: `models.search-index.ts` sorts `modelsFilterableAttributes`
// in place. Freezing is therefore safe for THIS list only because nothing sorts it — do not extend
// the freeze to the filterable list without removing that `.sort()` first.
Object.freeze(modelsDisplayedAttributes);
Object.freeze(MODELS_WITHHELD_ATTRIBUTES);
