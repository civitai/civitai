<script lang="ts">
  import MyTrainings from '../../routes/MyTrainings.svelte';
  import TrainingFlow from '../../routes/TrainingFlow.svelte';
  import RunView from './RunView.svelte';
  import { backend, navigate, type StudioLocation } from '$lib/host';

  // The element's internal views — the host owns the URL space and hands us a location; everything
  // below resolves data through the backend seam, so no view ever leaves the embedding page.
  let {
    location,
    reloadTick = 0,
  }: { location: StudioLocation; reloadTick?: number } = $props();

  // `reloadTick` is the host-context refresh(): bumping it rebuilds the promises, so "server data is
  // stale" re-reads the current view. Entering a view re-derives too, so home is always fresh after
  // a submit.
  const rowsPromise = $derived(
    location.view === 'home' ? (void reloadTick, backend().listTrainings()) : null
  );
  const pricesPromise = $derived(
    location.view === 'new' ? (void reloadTick, backend().getFromPrices()) : null
  );
</script>

{#if location.view === 'run'}
  <RunView workflowId={location.workflowId} />
{:else if location.view === 'new'}
  {#if pricesPromise}
    {#await pricesPromise}
      <div class="grid place-items-center py-20 font-mono text-sm text-dark-2">Loading pricing…</div>
    {:then prices}
      <TrainingFlow {prices} onExit={() => navigate({ view: 'home' })} />
    {:catch}
      <TrainingFlow prices={{}} onExit={() => navigate({ view: 'home' })} />
    {/await}
  {/if}
{:else if rowsPromise}
  {#await rowsPromise}
    <p class="p-6 font-mono text-sm text-dark-2">Loading trainings…</p>
  {:then rows}
    <MyTrainings {rows} onNew={() => navigate({ view: 'new' })} />
  {:catch err}
    <p class="p-6 font-mono text-sm text-red-400">
      Could not load trainings: {err instanceof Error ? err.message : String(err)}
    </p>
  {/await}
{/if}
