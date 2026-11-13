<script lang="ts">
  import { untrack } from 'svelte';
  import type { ModelRuleView } from '$lib/server/model-rules.service';
  import { createRuleDraftsSync } from '$lib/text-scan-lab/rule-drafts.svelte';
  import type { PageData } from './$types';
  import LiteralTry from './LiteralTry.svelte';
  import RulesList from './RulesList.svelte';

  let {
    rules,
    dismissals,
    query,
    canEdit,
    userId,
    url,
  }: {
    rules: ModelRuleView[];
    /** Holds dismissed as "not this subject", by rule id. */
    dismissals: Record<number, number>;
    query: PageData['query'];
    canEdit: boolean;
    userId: number;
    url: URL;
  } = $props();

  const drafts = createRuleDraftsSync(untrack(() => userId), () => rules);
  const overrides = $derived(drafts.overrides(rules));
  const tryRules = $derived(JSON.stringify(overrides));
</script>

<div class="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
  <div class="min-w-0">
    <RulesList {rules} {dismissals} {drafts} {query} {canEdit} {url} />
  </div>
  <LiteralTry rules={tryRules} editedCount={overrides.length} />
</div>
