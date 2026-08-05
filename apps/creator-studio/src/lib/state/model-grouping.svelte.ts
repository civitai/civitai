import { CookieState } from '$lib/state/cookie-state.svelte';
import { MODEL_GROUPING_COOKIE, type ModelGrouping } from '$lib/model-grouping';

/** Version-vs-model row grouping for /analytics/models, persisted per creator. */
export function modelGroupingState(canonical: () => ModelGrouping) {
  const state = new CookieState<ModelGrouping>(MODEL_GROUPING_COOKIE, canonical);
  return {
    get value() {
      return state.value;
    },
    set(next: ModelGrouping) {
      return state.set(next);
    },
  };
}
