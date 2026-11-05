<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { Tabs, TabsList, TabsTrigger } from '@civitai/ui/components/ui/tabs/index.js';
  import { num } from '$lib/format';
  import { INQUISITOR_FILTERS, INQUISITOR_FILTER_LABELS } from '$lib/knights/inquisitor-filters';
  import { urlWith } from '$lib/url';
  import InquisitorCard from './InquisitorCard.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
</script>

<header class="page-header">
  <h1>Knights of New Order Inquisitor queue</h1>
  <p>
    Images the Knights could not settle: split votes that ran out of ranks, large down-ratings, Blocked
    suggestions and write-backs that failed. Your rating is set on the image as a moderator ruling and
    every pending vote is graded against it.
  </p>
</header>

<Tabs
  class="mb-4"
  value={data.filter}
  onValueChange={(value) =>
    value && goto(urlWith(page.url, { filter: value === 'all' ? null : value }))}
>
  <TabsList>
    {#each INQUISITOR_FILTERS as filter (filter)}
      <TabsTrigger value={filter}>
        {INQUISITOR_FILTER_LABELS[filter]} ({num(data.counts[filter])})
      </TabsTrigger>
    {/each}
  </TabsList>
</Tabs>

{#if data.items.length === 0}
  <p class="text-sm text-dark-2">
    {data.filter === 'all'
      ? 'No images are waiting for an Inquisitor ruling.'
      : 'No images match this filter.'}
  </p>
{:else}
  <div class="flex flex-col gap-3">
    {#each data.items as item (item.id)}
      <InquisitorCard {item} />
    {/each}
  </div>
  {#if data.items.length >= data.limit}
    <p class="mt-3 text-xs text-dark-2">Showing the first {data.limit}, by priority and age.</p>
  {/if}
{/if}
