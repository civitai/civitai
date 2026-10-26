<script lang="ts">
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { dateTime } from '$lib/format';
  import { HIGHLIGHT_LEGEND } from '$lib/prompt-highlight';
  import { originSummary } from '$lib/restrictions/origin';
  import {
    RECHECK_BLOCKS,
    RECHECK_NOT_BLOCKING,
    recheckReasonLabels,
    type Recheck,
  } from '$lib/restrictions/recheck';
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
  const originMix = $derived(originSummary(triggers).chip);
  const range = $derived(
    summary.first && summary.last
      ? `${dateTime(summary.first)} → ${dateTime(summary.last)}`
      : undefined
  );

  const WARN = 'border-amber-500/40 bg-amber-500/10 text-amber-300';
  const tone = (label: string) =>
    label === RECHECK_NOT_BLOCKING
      ? 'warn'
      : label.startsWith(RECHECK_BLOCKS)
        ? 'block'
        : 'plain';
</script>

<section
  class="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-dark-4 bg-dark-7 px-3.5 py-2.5"
>
  <p class="m-0 text-sm font-medium text-white" title={range}>
    {summary.total}
    {summary.total === 1 ? 'trigger' : 'triggers'}
  </p>
  <div class="flex flex-wrap items-center gap-1.5">
    {#each summary.reasons as item (item.label)}
      {@const t = tone(item.label)}
      <Badge
        variant={t === 'block' ? 'destructive' : 'outline'}
        class={t === 'warn' ? WARN : undefined}
      >
        {item.label} × {item.count}
      </Badge>
    {/each}
    {#if summary.sources.length > 1}
      {#each summary.sources as item (item.label)}
        <Badge variant="secondary">{item.label} × {item.count}</Badge>
      {/each}
    {/if}
    {#if originMix}
      <Badge variant="outline" class="text-dark-0">{originMix}</Badge>
    {/if}
  </div>
</section>
