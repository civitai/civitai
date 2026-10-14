<script lang="ts">
  import ModelReports from './ModelReports.svelte';
  import ReportsTable from './ReportsTable.svelte';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();
</script>

<!-- One route, two layouts. Model reports have their own: a queue, the model itself and its actions on
     one screen, built with the mods who work them. Every other type keeps the shared table with its
     side panel (`ReportsTable`), so the model-specific layout does not reshape a queue nobody has
     reviewed for it; each one moves over deliberately, when it is looked at. -->
{#if data.type === 'model'}
  <ModelReports {data} />
{:else}
  <ReportsTable {data} {form} />
{/if}
