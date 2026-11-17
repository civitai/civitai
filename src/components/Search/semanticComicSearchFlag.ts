/**
 * Whether comic search answers from the semantic search (`semanticComicSearch`). Its own module,
 * with no imports, so FeatureFlagsProvider can set it without pulling the search client's tRPC
 * graph into everything that renders the provider.
 */
let enabled = false;

export function setSemanticComicSearchEnabled(value: boolean) {
  enabled = value;
}

export const isSemanticComicSearchEnabled = () => enabled;
