<script lang="ts">
  import type { Snippet } from 'svelte';
  import { cn } from '@civitai/ui/utils.js';
  import {
    LABEL_NAMES,
    checkExpected,
    describeVerdict,
    verdictsDiffer,
    type VerdictTone,
  } from '$lib/text-scan-lab/labels';
  import type { Expected, LabLabel, LabScanResult } from '$lib/text-scan-lab/types';

  let {
    label,
    columns,
    expected = null,
    actions,
  }: {
    label: LabLabel;
    /** One column, or two (current and changed) side by side. */
    columns: { title: string; result: LabScanResult }[];
    expected?: Expected | null;
    actions?: Snippet;
  } = $props();

  const TONE_CLASS: Record<VerdictTone, string> = {
    clear: 'text-green-300',
    neutral: 'text-white',
    flagged: 'text-amber-300',
    unknown: 'text-red-300',
  };

  const differs = $derived(
    columns.length === 2 && verdictsDiffer(label, columns[0].result, columns[1].result)
  );
</script>

<div
  class={cn(
    'min-w-0 rounded-lg border bg-dark-7 p-4',
    differs ? 'border-amber-500/60' : 'border-dark-4'
  )}
>
  <div class="flex items-center justify-between gap-2">
    <h4 class="text-xs font-semibold uppercase tracking-wide text-dark-2">
      {LABEL_NAMES[label]}{differs ? ' · differs' : ''}
    </h4>
    {@render actions?.()}
  </div>
  <div class={cn('mt-2 grid gap-4', columns.length === 2 && 'sm:grid-cols-2')}>
    {#each columns as column (column.title)}
      {@const verdict = describeVerdict(label, column.result)}
      {@const check = expected ? checkExpected(expected, label, column.result) : null}
      <div class="min-w-0">
        {#if columns.length > 1}
          <p class="text-xs text-dark-2">{column.title}</p>
        {/if}
        <p class={cn('whitespace-pre-wrap break-words font-semibold', TONE_CLASS[verdict.tone])}>
          {verdict.headline}
        </p>
        {#if verdict.reason}
          <p class="mt-1 whitespace-pre-wrap break-words text-sm text-dark-0">{verdict.reason}</p>
        {/if}
        {#if check}
          <p class={cn('mt-2 text-xs', check.asExpected ? 'text-green-300' : 'text-red-300')}>
            {check.asExpected ? '✓ as expected' : `✗ expected ${check.expected}`}
          </p>
        {/if}
      </div>
    {/each}
  </div>
</div>
