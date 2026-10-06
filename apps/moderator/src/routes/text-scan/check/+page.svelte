<script lang="ts">
  import type { ActionData } from './$types';
  import CheckForm from './CheckForm.svelte';
  import CheckItem from './CheckItem.svelte';

  let { data } = $props();

  type CheckData = Extract<NonNullable<ActionData>, { checked: true }>;

  let result = $state<CheckData | null>(null);
</script>

<svelte:head><title>Check · Text scan</title></svelte:head>

<h1 class="mb-4 text-xl font-semibold text-white">Check</h1>

<CheckForm onchecked={(r) => (result = r as CheckData)} />

{#if result}
  <div class="mt-6 space-y-4">
    {#if result.notice}
      <p class="text-sm text-amber-300">{result.notice}</p>
    {/if}
    {#if result.skipped.length}
      <p class="whitespace-pre-wrap text-sm text-amber-300">
        Couldn't load: {result.skipped.map((s) => `${s.entityId} (${s.error})`).join(', ')}
      </p>
    {/if}
    <!-- A new check starts every item's save form afresh, even where an item key repeats. -->
    {#key result}
      {#each result.items as item (item.key)}
        <CheckItem
          {item}
          entityType={result.entityType}
          labels={result.labels}
          testSets={data.testSets}
        />
      {/each}
    {/key}
  </div>
{/if}
