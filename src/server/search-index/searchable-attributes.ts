// Kept a leaf so a test and any future writer can read this without loading
// `~/server/meilisearch/client`, which builds pLimit/prom collectors at module load. Same
// reasoning as ./displayed-attributes.ts, ./filterable-attributes.ts and ./sortable-attributes.ts.

// 🔴 THIS IS THE FOURTH ATTRIBUTE LIST, AND IT IS THE ONE AN ENUMERATION KEEPS MISSING. It lived
// inline in `onIndexSetup` in ./models.search-index.ts while the other three were already exported
// module constants, and that asymmetry is what made it invisible: two separate comments — at the
// projection site and in ./displayed-attributes.ts — enumerated "not filterable, not sortable, not
// displayed" and stopped there, and both had to be corrected.
//
// 🔴 It is a WHITELIST standing in for Meilisearch's `["*"]` default, so its contents are a safety
// boundary and not a tuning knob. Measured on a local Meilisearch 1.54.0 with two documents
// carrying `42` and `77`, with positive and negative controls: with this whitelist `q=42` returns
// 0 hits; with `["*"]` it returns 1, `q=77` returns the OTHER document (per-document
// discrimination) and `q=999` returns 0. A bare `'insight'` PARENT entry is a real route too, not
// only a leaf one — `["name","insight"]` makes `q=42` and `q=render_3d` each return 1 hit, while
// the leaf-only `["name","insight.role"]` returns 0 for `42`.
//
// So widening this list ships a per-document MEMBERSHIP ORACLE on internal label outcomes
// ("which model's winning version is 42", one guess at a time) to anyone holding the
// browser-published client key in `src/env/client-schema.ts`. It is not a value leak — the hit
// body still withholds `insight`, which is ./displayed-attributes.ts's separate mechanism — and
// `insight.modelVersionId` is the leaf for which this list is one of only two things keeping it
// unreachable. The argument for writing that id at all is at the projection site in
// ./models.search-index.ts.
export const modelsSearchableAttributes = ['name', 'user.username', 'hashes', 'triggerWords'];

// 🔴 FROZEN, and the freeze is what makes hoisting this list a net improvement rather than a wider
// hazard. ./displayed-attributes.ts records the measurement: that list went from a mutable
// function-local copy to an exported constant, the move was claimed to close the mutation class,
// and it did NOT — an export is handed out BY REFERENCE, so `modelsDisplayedAttributes.push(…)`
// anywhere in the process re-opened the leak in one line and passed the entire suite. "Worse than
// the local copy it replaced", in that file's own words.
//
// This list arrived at module scope the same way, so it inherits the same hazard and the same cure.
// `Array.prototype.push` on a non-extensible object throws on its own account, strict mode or not;
// strict mode is what additionally makes a bracket assignment (`arr[0] = '*'`) throw rather than
// silently no-op.
//
// ⚠️ `as const` would make `.push` a COMPILE error as well, which would be strictly better — but it
// does not type-check here. The client's `updateSearchableAttributes` takes
// `SearchableAttributes = string[] | null` (meilisearch 0.33.0,
// `node_modules/meilisearch/dist/types/types/types.d.ts:145`), and a `readonly` tuple is not
// assignable to `string[]`. The only ways to satisfy it are a spread or a cast at the call site,
// and both are exactly the shapes the write-argument guard in
// ./__tests__/models-index-insight-projection.test.ts exists to forbid. Runtime freeze it is.
//
// Nothing sorts this list, which is what makes the freeze safe here — the same caveat
// ./displayed-attributes.ts attaches to its own freeze, where ./models.search-index.ts sorts
// `modelsFilterableAttributes` in place.
Object.freeze(modelsSearchableAttributes);
