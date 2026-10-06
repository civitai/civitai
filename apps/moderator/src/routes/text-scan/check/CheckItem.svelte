<script lang="ts">
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { describeExpected } from '$lib/text-scan-lab/labels';
  import type { LabEntityType, LabLabel, PromptKey } from '$lib/text-scan-lab/types';
  import type { CheckItemResult } from './+page.server';
  import SaveCaseForm from './SaveCaseForm.svelte';
  import ScanDetails from './ScanDetails.svelte';
  import VerdictCard from './VerdictCard.svelte';

  let {
    item,
    entityType,
    labels,
    testSets,
    changedTitle,
    onedit,
  }: {
    item: CheckItemResult;
    entityType: LabEntityType;
    labels: readonly LabLabel[];
    /** Sets a case can be saved to; none hides saving. */
    testSets: { id: number; name: string }[];
    /** Heading of the second column, when the item was also scanned with changes. */
    changedTitle: string;
    onedit: (key: PromptKey) => void;
  } = $props();

  const labelKey = (label: LabLabel): PromptKey => `label:${label}`;

  const expected = $derived(item.fromCase?.expected ?? null);
  const expectedText = $derived(
    expected
      ? labels
          .map((l) => describeExpected(expected)[l])
          .filter(Boolean)
          .join(' · ') || 'nothing scored'
      : null
  );

  const columns = $derived(
    item.changed
      ? [
          { title: 'Current', result: item.current },
          { title: changedTitle, result: item.changed },
        ]
      : [{ title: 'Current', result: item.current }]
  );
</script>

<section class="rounded-xl border border-dark-4 bg-dark-6 p-5">
  <h3 class="text-sm font-semibold text-white">{item.title}</h3>
  {#if expectedText}
    <p class="mt-1 text-xs text-dark-2">Expected: <span class="text-dark-0">{expectedText}</span></p>
  {/if}

  <div class="mt-3 grid gap-3 lg:grid-cols-2">
    {#each labels as label (label)}
      <VerdictCard {label} {columns} {expected}>
        {#snippet actions()}
          <Button size="xs" variant="ghost" onclick={() => onedit(labelKey(label))}>
            Edit definition
          </Button>
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
      <div class="grid gap-3 lg:grid-cols-2">
        {#each columns as column (column.title)}
          <ScanDetails title={column.title} result={column.result} />
        {/each}
      </div>
    </div>
  </details>

  {#if testSets.length && !item.fromCase}
    <SaveCaseForm {item} {entityType} {labels} {testSets} />
  {/if}
</section>
