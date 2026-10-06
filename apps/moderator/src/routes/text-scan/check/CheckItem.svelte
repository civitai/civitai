<script lang="ts">
  import type { LabEntityType, LabLabel } from '$lib/text-scan-lab/types';
  import type { CheckItemResult } from './+page.server';
  import SaveCaseForm from './SaveCaseForm.svelte';
  import ScanDetails from './ScanDetails.svelte';
  import VerdictCard from './VerdictCard.svelte';

  let {
    item,
    entityType,
    labels,
    testSets,
  }: {
    item: CheckItemResult;
    entityType: LabEntityType;
    labels: readonly LabLabel[];
    testSets: { id: number; name: string }[];
  } = $props();
</script>

<section class="rounded-xl border border-dark-4 bg-dark-6 p-5">
  <h3 class="text-sm font-semibold text-white">{item.title}</h3>

  <div class="mt-3 grid gap-3 lg:grid-cols-2">
    {#each labels as label (label)}
      <VerdictCard {label} columns={[{ title: 'Current', result: item.current }]} />
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
      <ScanDetails title="Current" result={item.current} />
    </div>
  </details>

  {#if testSets.length}
    <SaveCaseForm {item} {entityType} {labels} {testSets} />
  {/if}
</section>
