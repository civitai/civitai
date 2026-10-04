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
// boundary and not a tuning knob. Measurements recorded at the projection site in
// ./models.search-index.ts and in ./displayed-attributes.ts — taken against a local Meilisearch
// with positive and negative controls, and restated here rather than re-derived: with this
// whitelist `q=42` returns 0 hits; with `["*"]` it returns 1, and `q=77` returns the OTHER
// document, i.e. per-document discrimination. A bare `'insight'` PARENT entry is a real route too,
// not only a leaf one, which is why the projection guard filters on `startsWith('insight')`
// rather than `startsWith('insight.')`.
//
// So widening this list ships a per-document MEMBERSHIP ORACLE on internal label outcomes
// ("which model's winning version is 42", one guess at a time) to anyone holding the
// browser-published client key in `src/env/client-schema.ts`. It is not a value leak — the hit
// body still withholds `insight`, which is ./displayed-attributes.ts's separate mechanism.
//
// 🔴 DO NOT WRITE DOWN HOW MANY MECHANISMS KEEP `insight.modelVersionId` UNREACHABLE WITHOUT
// COUNTING TO FOUR. An earlier draft of THIS paragraph said "one of only two things", which is
// the same truncated enumeration this file was created to stop — three separate comments in this
// tree have had to be corrected for it, and one of them was being corrected in the same commit
// that introduced this one. There are FOUR attribute lists and each absence does different work:
// ./displayed-attributes.ts is the only one keeping the leaf out of a SERIALISED hit;
// ./filterable-attributes.ts and ./sortable-attributes.ts keep it out of the filter/sort oracle;
// and THIS list keeps it out of free-text matching. The argument for writing that id at all is at
// the projection site in ./models.search-index.ts.
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
