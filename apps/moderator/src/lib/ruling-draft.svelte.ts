import {
  chooseVerdict,
  emptyRulingDraft,
  type RulingDraft,
} from '$lib/components/RulingForm.svelte';

/** A two-pane queue's in-progress ruling, cleared whenever `item` (the open item's key) changes. */
export function rulingDraft<V extends string>(item: () => unknown) {
  let draft = $state<RulingDraft<V>>(emptyRulingDraft<V>());
  $effect(() => {
    item();
    draft = emptyRulingDraft<V>();
  });
  return {
    get current() {
      return draft;
    },
    set current(next: RulingDraft<V>) {
      draft = next;
    },
    choose(verdict: V) {
      draft = chooseVerdict(draft, verdict);
    },
  };
}
