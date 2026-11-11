/**
 * Whether article search answers from the semantic search (`semanticArticleSearch`). Its own module,
 * with no imports, so FeatureFlagsProvider can set it without pulling the search client's tRPC
 * graph into everything that renders the provider.
 */
let enabled = false;

export function setSemanticArticleSearchEnabled(value: boolean) {
  enabled = value;
}

export const isSemanticArticleSearchEnabled = () => enabled;
