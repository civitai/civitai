<script lang="ts">
  import type {
    ModelRulesHoldMatch,
    StoredModelRuleSnapshot,
  } from '@civitai/moderation/model-rules';
  import RuleReferences from '$lib/components/model-rule-holds/RuleReferences.svelte';
  import TriageCard from '$lib/components/triage/TriageCard.svelte';

  let {
    rules,
    matches,
  }: { rules: StoredModelRuleSnapshot[]; matches: ModelRulesHoldMatch[] } = $props();

  // One line per distinct term and field: a term written twice in a field is one finding.
  const termsOf = (ruleId: number) => [
    ...new Map(
      matches
        .filter((match) => match.ruleId === ruleId)
        .map((match) => [`${match.field}\u0000${match.term}`, match])
    ).values(),
  ];
</script>

<TriageCard dense title={rules.length > 1 ? 'Matched rules' : 'Matched rule'}>
  <ul class="m-0 list-none space-y-3 p-0">
    {#each rules as rule (rule.id)}
      <li>
        <p class="m-0 flex flex-wrap items-center gap-x-2 gap-y-1 text-[15px] font-medium text-white">
          {rule.subject}
          <RuleReferences category={rule.category} />
        </p>
        {#if rule.description}
          <p class="m-0 mt-0.5 text-dark-0">{rule.description}</p>
        {/if}
        {#if rule.references?.length}
          <p class="m-0 mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]">
            <span class="text-dark-2">References</span>
            <RuleReferences references={rule.references} />
          </p>
        {/if}
        <ul class="m-0 mt-1.5 list-none space-y-0.5 p-0 text-dark-0">
          {#each termsOf(rule.id) as match (`${match.field}:${match.term}`)}
            <li>
              term <mark class="rounded-sm bg-amber-500/30 px-0.5 text-amber-100">{match.term}</mark>
              in {match.field}
            </li>
          {:else}
            <li class="text-dark-2">No matched term was stored.</li>
          {/each}
        </ul>
      </li>
    {:else}
      <li class="text-dark-2">The hold stored no rule.</li>
    {/each}
  </ul>
</TriageCard>
