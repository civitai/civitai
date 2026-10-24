// A leaf for the same reason as ./searchable-attributes.ts: the apply route and the tests read it
// without loading `~/server/meilisearch/client`.
//
// Meilisearch applies these in order, and each rule only breaks ties left by the ones before it.
// `metrics.thumbsUpCount:desc` is unique enough that nothing after it ever decides anything, so
// relevance is effectively `attribute` (which field matched, and how early in it) then popularity.
//
// `isOfficial:desc` sits between the two so a model Civitai publishes outranks community models that
// match the query at the same name position; without it a bare "MOSS" listed "Mossa…" LoRAs with
// more thumbs above the official "MOSS Image".
//
// Do not move `exactness` above popularity to fix that kind of query: its first bucket is "some
// attribute EQUALS the query", which a trigger word satisfies, so "pony" then ranks a small LoRA
// whose trigger word is "pony" above Pony Diffusion V6 XL.
//
// Adding a field to an asc/desc rule makes Meilisearch build facet data for it across the index; a
// pure reorder does not. To apply to the live index, use
// src/pages/api/admin/temp/apply-models-index-ranking-rules.ts.
export const modelsRankingRules = [
  'sort',
  'attribute',
  'isOfficial:desc',
  'metrics.thumbsUpCount:desc',
  'words',
  'proximity',
  'exactness',
];

Object.freeze(modelsRankingRules);
