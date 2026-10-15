import { onMount, untrack } from 'svelte';
import { browserStorage } from './changes.svelte';
import {
  RuleDraftsState,
  ruleDraftsStorageKey,
  type RuleDraftsFields,
  type SavedRule,
} from './rule-drafts';

/** Rule drafts kept in step with the page; call during component initialisation. */
export function createRuleDraftsSync(
  moderatorId: number,
  rules: () => readonly SavedRule[]
): RuleDraftsState {
  const fields = $state<RuleDraftsFields>({ drafts: {} });
  const drafts = new RuleDraftsState(fields, browserStorage(), ruleDraftsStorageKey(moderatorId));
  let mounted = $state(false);
  onMount(() => {
    drafts.reload();
    drafts.prune(rules());
    mounted = true;
    const onStorage = (e: StorageEvent) => {
      if (e.key === null || e.key === ruleDraftsStorageKey(moderatorId)) drafts.reload();
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  });
  $effect(() => {
    const next = rules();
    if (mounted) untrack(() => drafts.prune(next));
  });
  return drafts;
}
