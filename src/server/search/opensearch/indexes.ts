// OpenSearch aliases the site reads. A leaf, so the search path can name them without loading the
// index builders.

/** The models index alias; each rebuild is a concrete index behind it (see index-build.ts). */
export const MODELS_INDEX_ALIAS = 'models';
