<script lang="ts">
  import { page } from '$app/state';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';
  import { filtersSchema } from '$lib/shadow-sexual-prompt';
  import Agreement from './Agreement.svelte';
  import DailyCounts from './DailyCounts.svelte';
  import Filters from './Filters.svelte';
  import WouldRaiseList from './WouldRaiseList.svelte';

  let { data } = $props();

  // The same schema the server parses with, so both sides agree on the defaults.
  const filters = $derived(filtersSchema.parse(Object.fromEntries(page.url.searchParams)));
</script>

<svelte:head><title>Shadow sexual prompt · Text scan</title></svelte:head>

<div class="mb-4">
  <h1 class="text-xl font-semibold text-white">Shadow sexual prompt</h1>
  <p class="mt-1 max-w-3xl text-sm text-dark-2">
    What the shadow prompt scan would do to image ratings, beside the rating each image had when it
    was scanned. Nothing here changes an image. Each image counts once, by its latest scan; a fire on
    the negative prompt does not count.
  </p>
</div>

<Filters {filters} />

{#snippet failed(what: string)}
  <ErrorAlert message={`Could not load ${what}.`} />
{/snippet}

<section class="mb-5 rounded-xl border border-dark-4 bg-dark-6 p-5">
  <h2 class="mb-3 text-base font-semibold text-white">By day</h2>
  {#await data.daily}
    <p class="text-sm text-dark-2">Counting scans…</p>
  {:then rows}
    <DailyCounts {rows} />
  {:catch}
    {@render failed('the daily counts')}
  {/await}
</section>

<div class="grid gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
  <section class="rounded-xl border border-dark-4 bg-dark-6 p-5">
    <h2 class="mb-3 text-base font-semibold text-white">Would raise</h2>
    <WouldRaiseList currentPage={filters.page} civitaiUrl={data.civitaiUrl} />
  </section>

  <section class="rounded-xl border border-dark-4 bg-dark-6 p-5">
    <h2 class="mb-3 text-base font-semibold text-white">Fires by level at scan</h2>
    {#await data.agreement}
      <p class="text-sm text-dark-2">Counting…</p>
    {:then rows}
      <Agreement {rows} />
    {:catch}
      {@render failed('the agreement table')}
    {/await}
  </section>
</div>
