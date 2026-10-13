<script lang="ts">
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { itemChanged, type TryItem, type TrySide } from '$lib/text-scan-lab/try';
  import type { LabLabel, PromptKey } from '$lib/text-scan-lab/types';
  import ScanDetails from './ScanDetails.svelte';
  import VerdictCard from './VerdictCard.svelte';

  let {
    item,
    labels,
    current,
    edited,
    onedit,
  }: {
    item: TryItem;
    labels: readonly LabLabel[];
    current: TrySide;
    edited: TrySide | null;
    onedit: ((key: PromptKey) => void) | null;
  } = $props();

  const changed = $derived(itemChanged(item, labels));
  const labelKey = (label: LabLabel): PromptKey => `label:${label}`;

  const columns = $derived(
    item.edited
      ? [
          { title: 'Current', result: item.current, rules: current.rules },
          { title: 'Edited', result: item.edited, rules: edited?.rules ?? null },
        ]
      : [{ title: 'Current', result: item.current, rules: current.rules }]
  );
</script>

<section class="rounded-xl border border-dark-4 bg-dark-6 p-5">
  <div class="flex items-center gap-2">
    <h3 class="text-sm font-semibold text-white">{item.title}</h3>
    {#if changed}
      <Badge variant="outline" class="border-amber-500/60 text-amber-300">Changed</Badge>
    {/if}
  </div>

  <div class="mt-3 grid gap-3">
    {#each labels as label (label)}
      <VerdictCard {label} {columns}>
        {#snippet actions()}
          {#if onedit}
            <Button size="xs" variant="ghost" onclick={() => onedit?.(labelKey(label))}>
              Edit definition
            </Button>
          {/if}
        {/snippet}
      </VerdictCard>
    {/each}
  </div>

  <details class="mt-3">
    <summary class="text-xs text-dark-2">Details</summary>
    <div class="mt-2 space-y-3">
      <div class="space-y-2">
        {#each item.fields as field, i (i)}
          <div>
            <p class="text-xs font-semibold text-dark-2">{field.heading}</p>
            <p class="whitespace-pre-wrap break-words text-sm text-dark-0">{field.text}</p>
          </div>
        {/each}
      </div>
      <div class="grid gap-3 xl:grid-cols-2">
        {#each columns as column (column.title)}
          <ScanDetails title={column.title} result={column.result} />
        {/each}
      </div>
    </div>
  </details>
</section>
