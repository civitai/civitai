<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { Tabs, TabsList, TabsTrigger } from '@civitai/ui/components/ui/tabs/index.js';
  import { num } from '$lib/format';
  import {
    DEFAULT_INQUISITOR_FILTER,
    INQUISITOR_FILTERS,
    INQUISITOR_FILTER_LABELS,
    parseInquisitorFilter,
    type InquisitorFilter,
  } from '$lib/knights/inquisitor-filters';
  import { urlWith } from '$lib/url';
  import InquisitorCard from './InquisitorCard.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  const applyFilter = (filter: InquisitorFilter) =>
    goto(
      urlWith(page.url, { filter: filter === DEFAULT_INQUISITOR_FILTER ? null : filter }),
      { keepFocus: true, noScroll: true }
    );
  const shownCount = $derived(data.counts[data.filter]);
</script>

<header class="page-header">
  <h1>Knights of New Order Inquisitor queue</h1>
  <p>
    Images the Knights could not settle: split votes that ran out of ranks, large down-ratings, Blocked
    suggestions and write-backs that failed. Your rating is set on the image as a moderator ruling and
    every pending vote is graded against it.
  </p>
</header>

<!-- One-way `value`: the `Tabs` wrapper does not declare `value` bindable, so a function binding does not compile. `load` owns the filter and a click only navigates. -->
<Tabs
  class="mb-4"
  value={data.filter}
  onValueChange={(value) => value && applyFilter(parseInquisitorFilter(value))}
>
  <TabsList class="justify-start">
    {#each INQUISITOR_FILTERS as filter (filter)}
      <TabsTrigger value={filter}>
        {INQUISITOR_FILTER_LABELS[filter]} ({num(data.counts[filter])})
      </TabsTrigger>
    {/each}
  </TabsList>
</Tabs>

{#if data.items.length === 0}
  <p class="text-sm text-dark-2">
    {data.filter === DEFAULT_INQUISITOR_FILTER
      ? 'No images are waiting for an Inquisitor ruling.'
      : `Nothing waiting under “${INQUISITOR_FILTER_LABELS[data.filter]}”.`}
  </p>
{:else}
  <div class="flex flex-col gap-3">
    {#each data.items as item (item.id)}
      <InquisitorCard {item} />
    {/each}
  </div>
  {#if shownCount > data.limit}
    <p class="mt-3 text-xs text-dark-2">Showing the first {data.limit} of {num(shownCount)}.</p>
  {/if}
{/if}
