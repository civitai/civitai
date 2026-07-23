import { LocalState } from '$lib/state/local-state.svelte';

// Which base models the creator has pinned on the Civitai-wide usage chart. Empty = "not chosen yet" — the page
// falls back to a sensible default (the top few).
export const baseModelTrendSelection = new LocalState<string[]>('basemodel-trend', []);
