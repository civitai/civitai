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
  // Sort-only AND filter-only: `insight.qualityScore` is in both `modelsSortableAttributes` and
  // `modelsFilterableAttributes`, and no consumer reads it off a hit — the resource-intent matcher
  // reads the scores it needs from Postgres via `loadResourceInsights`. The
  // top-level key is `insight` because `transformData` emits
  // `insight: { qualityScore, role, styleFamily, modelVersionId }`, and this list is keyed on
  // top-level attributes (nested children ride along with their parent).
  // 🔴 That ride-along is what keeps the two MEANING axes — `insight.role` and
  // `insight.styleFamily`, filter-only, added later than the score — out of a serialised hit
  // with no edit here. Confirmed on the OTHER path too, which this whitelist cannot reach:
  // `withheldStripped` in ./models.search-index.ts `delete`s the top-level `insight` key, taking
  // the whole object with it. Neither needed an entry per axis — which is also why a future axis
  // promoted to a TOP-LEVEL key WOULD need its own entry here.
  //
  // 🔴 AND FOR `insight.modelVersionId` THE RIDE-ALONG IS LOAD-BEARING RATHER THAN CONVENIENT.
  // That leaf is in no OTHER attribute list — not filterable, not sortable, and not in the
  // `modelsSearchableAttributes` whitelist (./searchable-attributes.ts). ⚠️ THIS NAMED THE LIST
  // `searchableAttributes`, which sends a reader looking for a function-local inside
  // `onIndexSetup` that no longer exists — and it did so UPSTREAM of the marked note further down
  // this block that explains why older comments spell it that way, so the reader hits the dead
  // name first and the explanation second. The export's name is the one to write.
  // So unlike the three beside it, this entry is the only one
  // of the four lists keeping it out of a serialised hit: `attributesToRetrieve` can narrow
  // within the displayed set but cannot re-admit a withheld attribute, so withholding `insight`
  // is what makes "no search path returns the winning version id" true. Removing `insight` from
  // this list to expose something else therefore also publishes that id, and it cannot be done
  // per-leaf — both mechanisms key on the top-level attribute. The argument for why the id is
  // written at all, and the two routes that would make it readable (neither approved), are at
  // the projection site in ./models.search-index.ts.
  //
  // ⚠️ "THE ONLY THING KEEPING IT UNREADABLE" IS WHAT THIS USED TO SAY, over an enumeration of
  // "not filterable, not sortable" — the same incomplete enumeration this change corrected at
  // the projection site, where the fourth list was missing too. There are FOUR exported
  // constants, not three: this one, ./filterable-attributes.ts, ./sortable-attributes.ts and
  // ./searchable-attributes.ts, the last of which stands in for Meili's `["*"]` default.
  // (⚠️ It was a function-local literal inside `onIndexSetup` when this paragraph was written,
  // which is why older comments describe it that way — and that asymmetry is exactly what made
  // it the one an enumeration keeps missing.) Widening that
  // whitelist is a route to reachability with no edit to THIS file, so it is not covered by the
  // sentence above. Measured on a local Meilisearch 1.54.0, two documents carrying `42` and
  // `77`, with positive and negative controls: with the real whitelist `q=42` returns 0 hits;
  // with `["*"]` it returns 1, `q=77` returns the OTHER document (per-document discrimination)
  // and `q=999` returns 0. ⚠️ A BARE `'insight'` PARENT ENTRY IS A REAL ROUTE, not only a leaf
  // one — `["name","insight"]` makes `q=42` and `q=render_3d` each return 1 hit, while the
  // leaf-only `["name","insight.role"]` returns 0 for `42` — which is why the projection guard
  // filters on `startsWith('insight')` and not `startsWith('insight.')`.
  //
  // What widening buys is a per-document MEMBERSHIP ORACLE, not a value leak — "which model
  // carries this value", one guess at a time — because the hit body still withholds `insight`:
  // measured, the hit stays `{"id":1,"name":"a model"}` even under `attributesToRetrieve: ["*"]`.
  // The hazard is that the two-mechanism reading makes a search-relevance change widening
  // `searchableAttributes` look safety-neutral ("undisplayed and unfilterable"), when it ships
  // that oracle on internal label outcomes to anyone holding the client key named below.
  //
  // 🔴 BUT READ "WITHHELD" AS **NOT SERIALISED INTO A HIT**, NEVER AS NOT DETERMINABLE, and do
  // not let the word do work it cannot do. These two mechanisms are the complete boundary on
  // what a hit CONTAINS and they are not a confidentiality control, because a FILTERABLE
  // attribute is an oracle: ./filterable-attributes.ts records, measured on v1.15.0, that
  // filtering works on a field this list withholds, and `src/components/Search/search.client.ts`
  // points the browser at the models index with a client key published in
  // `src/env/client-schema.ts`. So anyone holding that key can test a withheld-but-filterable
  // value against a document of their choosing, one equality at a time. The class is
  // pre-existing — `insight.qualityScore` has been filterable since it shipped, and it is the
  // more sensitive of the three — and acceptable here for the reason the next paragraph gives.
  // 🔴 It is NOT acceptable by default: if an axis arrives that genuinely must not be externally
  // derivable, declaring it filterable defeats BOTH mechanisms at once, and nothing in this file
  // or in that one will stop you.
  //
  // ⚠️ THERE IS ALSO A THIRD EXIT from the shared record builder that neither mechanism can
  // see, so the pair above is not an enumeration of paths: `getData(ids)` in
  // ./base.search-index.ts runs `pullData` + `transformData` and returns the transformed records
  // straight to its caller — not through `pushData` (so `displayedAttributes` never applies) and
  // not through `getModelSearchIndexRecords` (so `withheldStripped` never applies). It has NO
  // caller anywhere in the repo today, so this is a dormant exit rather than a live leak; it is
  // named here because the one leak this file exists to record got out the same way — through a
  // path the whitelist could not reach — and because it sits on an object whose sibling methods
  // are called freely from jobs and admin routes.
  // ⚠ Withholding it is not a privacy decision like `sortMetrics` — a quality label is not a
  // creator's hidden number — it is the same costs-nothing default this list's header describes,
  // and it keeps the field out of every public search hit until something actually needs it there.
  'insight',
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
