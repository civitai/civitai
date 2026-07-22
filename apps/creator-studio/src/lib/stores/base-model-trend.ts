import { persisted } from '$lib/stores/persisted';

// Which base models the creator has pinned on the Civitai-wide usage chart. Empty = "not chosen yet" — the page
// falls back to a sensible default (the top few).
export const baseModelTrendSelection = persisted<string[]>('basemodel-trend', []);
