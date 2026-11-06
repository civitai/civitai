<script lang="ts">
  import {
    modelRuleCategoryLabel,
    type ModelRuleCategory,
    type ModelRuleReference,
  } from '@civitai/moderation/model-rules';
  import MetaChip from '$lib/components/minor-flags/MetaChip.svelte';
  import { LINK_CLASS } from '$lib/format';
  import { referenceText } from '$lib/model-rule-holds';

  let {
    category,
    references = [],
  }: { category?: ModelRuleCategory; references?: ModelRuleReference[] } = $props();
</script>

{#if category}
  <MetaChip>{modelRuleCategoryLabel(category)}</MetaChip>
{/if}
{#each references as reference, i (i)}
  <a href={reference.url} target="_blank" rel="noopener noreferrer" class={LINK_CLASS}>
    {referenceText(reference)}
  </a>
{/each}
