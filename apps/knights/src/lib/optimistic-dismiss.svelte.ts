import { applyAction } from '$app/forms';
import { untrack } from 'svelte';
import {
  dismissFailedOn,
  dismissShowing,
  optimisticDismiss,
  syncDismiss,
  type DismissState,
} from './optimistic-dismiss';

/**
 * A one-off notice the load sends under `key` (null when it sends none): `showing` drops the moment its form is submitted,
 * `failed` says the last refused dismissal was this notice's, and `submit` is its form's `use:enhance`. `failure` is the
 * flag the action's own `fail` sets, so a lost answer shows the same error.
 */
export function dismissible(key: () => string | null, failure: Record<string, unknown>) {
  const state = $state<DismissState>({ closed: null, failed: null });
  const current = $derived(key());
  $effect(() => {
    const now = current;
    untrack(() => syncDismiss(state, now));
  });
  return {
    get showing() {
      return dismissShowing(current, state);
    },
    get failed() {
      return dismissFailedOn(state, current);
    },
    submit: optimisticDismiss({ state, key: () => current, failure, apply: applyAction }),
  };
}
