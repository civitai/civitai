<script lang="ts">
  import { dateTime } from '$lib/format';
  import { HIGHLIGHT_LEGEND } from '$lib/prompt-highlight';
  import { originSummary } from '$lib/restrictions/origin';
  import { RECHECK_NOT_BLOCKING, recheckReasonLabels, type Recheck } from '$lib/restrictions/recheck';
  import { formatSpan } from '$lib/restrictions/trigger-groups';
  import { summarizeTriggers } from '$lib/restrictions/trigger-summary';
  import type { RestrictionTriggerView } from '$lib/server/user-restriction.service';

  let {
    triggers,
    recheck,
  }: {
    triggers: RestrictionTriggerView[];
    recheck: Recheck | undefined;
  } = $props();

  const labels = $derived(
    Object.fromEntries(
      Object.entries(recheck?.byKey ?? {}).map(([key, index]) => [
        key,
        recheckReasonLabels(
          recheck!.results[index],
          (cat) => HIGHLIGHT_LEGEND.find((l) => l.cat === cat)?.label ?? cat
        ),
      ])
    )
  );
  const summary = $derived(summarizeTriggers(triggers, labels));
  const origin = $derived(originSummary(triggers).chip);
  const span = $derived(
    summary.first && summary.last ? Date.parse(summary.last) - Date.parse(summary.first) : null
  );
</script>

{#snippet tallies(title: string, items: { label: string; count: number }[])}
  <div class="min-w-0 space-y-1">
    <p class="m-0 text-xs font-semibold tracking-wide text-dark-2 uppercase">{title}</p>
    <ul class="m-0 list-none space-y-0.5 p-0 text-sm text-dark-0">
      {#each items as item (item.label)}
        {@const warn = item.label === `Re-check: ${RECHECK_NOT_BLOCKING}`}
        <li class={warn ? 'font-medium text-amber-300' : undefined}>
          {item.label}
          <span class={warn ? 'text-amber-300' : 'text-dark-2'}>× {item.count}</span>
        </li>
      {/each}
    </ul>
  </div>
{/snippet}

<section class="space-y-3 rounded-md border border-dark-4 bg-dark-6 p-3">
  <p class="m-0 text-sm text-white">
    {summary.total}
    {summary.total === 1 ? 'trigger' : 'triggers'}
    <span class="text-dark-2">·</span>
    {summary.distinctPrompts} distinct {summary.distinctPrompts === 1 ? 'prompt' : 'prompts'}
    {#if summary.first && summary.last && span}
      <span class="text-dark-2">·</span>
      {dateTime(summary.first)} → {dateTime(summary.last)}
      <span class="text-dark-2">({formatSpan(span)})</span>
    {:else if summary.first}
      <span class="text-dark-2">·</span>
      {dateTime(summary.first)}
    {/if}
  </p>
  <div class="grid gap-4 sm:grid-cols-2">
    {@render tallies('Why blocked', summary.reasons)}
    {@render tallies('Source', summary.sources)}
  </div>
  {#if origin}
    <p class="m-0 text-xs text-dark-2">Origin: <span class="text-dark-0">{origin}</span></p>
  {/if}
</section>
