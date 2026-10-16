import { emptyRulingDraft, type RulingDraft } from '$lib/components/RulingForm.svelte';

/** A two-pane queue's in-progress ruling. Choosing a verdict drops the reason and note written for
 *  the other one, and choosing it again clears it. */
export function rulingDraft<V extends string>() {
  let draft = $state<RulingDraft<V>>(emptyRulingDraft<V>());
  return {
    get current() {
      return draft;
    },
    set current(next: RulingDraft<V>) {
      draft = next;
    },
    choose(verdict: V) {
      draft = { verdict: draft.verdict === verdict ? null : verdict, reason: '', note: '' };
    },
    reset() {
      draft = emptyRulingDraft<V>();
    },
  };
}
