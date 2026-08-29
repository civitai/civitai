<script lang="ts">
  import { applyAction, enhance } from '$app/forms';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { SvelteSet } from 'svelte/reactivity';
  import type { SubmitFunction } from '@sveltejs/kit';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import ImageQueueGrid from '$lib/components/ImageQueueGrid.svelte';
  import type { ActionData, PageData } from './$types';
  import { clearPaging } from '$lib/paging';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';

  let { data, form }: { data: PageData; form: ActionData } = $props();
  // All nsfwLevel 0 here — strip it so the grid doesn't draw a meaningless rating badge.
  type Item = Omit<PageData['items'][number], 'nsfwLevel'>;

  const deleted = new SvelteSet<number>();
  $effect(() => {
    data.items;
    deleted.clear();
  });

  const items = $derived(data.items.map(({ nsfwLevel, ...rest }) => rest));

  function limitHref(n: number) {
    const url = new URL(page.url);
    url.searchParams.set('limit', String(n));
    clearPaging(url.searchParams);
    return url.pathname + url.search;
  }

  const deleteImage =
    (id: number): SubmitFunction =>
    () =>
    async ({ result }) => {
      if (result.type === 'success') deleted.add(id);
      else await applyAction(result);
    };
</script>

<header class="page-header">
  <h1>Missing Media</h1>
  <!-- Two populations, and the header names both because the second joined this queue after the
    first: images whose media could not be fetched or decoded, and images whose url is a
    browser-session `blob:` handle that can never render for anyone. Neither can be scanned, so
    there is nothing to rate; the only useful action is removing the row. Membership is
    `missingMediaWhere` in `$lib/server/ingestion.service` — keep this wording in step with it.

    🔴 THE WINDOW HAS TWO BOUNDS AND THE COPY NAMES BOTH. `ingestionErrorBaseWhere` is
    `createdAt > now() - '2 days' AND createdAt < now() - '1 hour'`, so a row younger than an hour
    is as absent from this page as one older than two days. Naming only the lower bound is the same
    defect this queue exists to close one bound over: copy promising a listing that may not contain
    the row the reader is looking for. -->
  <p class="mt-1 text-xs text-muted-foreground">
    These images can never be scanned, so there is nothing to rate: either the media behind them
    could not be fetched or decoded, or the url is a browser-session <code>blob:</code> handle that
    can never load for anyone else. Publishing one would put a permanently broken image on the site.
    Delete them, or ask the uploader to upload again. Only images created between 2 days and 1 hour
    ago are listed here — anything newer or older will not appear, even though it can still be
    deleted.
  </p>
  <div class="mt-1 flex items-center gap-1">
    <span class="text-xs text-muted-foreground">Per page:</span>
    {#each data.limitOptions as n (n)}
      <Button
        size="sm"
        variant={n === data.limit ? 'default' : 'outline'}
        onclick={() => n !== data.limit && goto(limitHref(n))}
      >
        {n}
      </Button>
    {/each}
  </div>
</header>

{#if form?.error}
  <ErrorAlert class="mb-4" message={form.error} />
{/if}

{#snippet card(image: Item)}
  <form method="POST" action="?/delete" use:enhance={deleteImage(image.id)}>
    <input type="hidden" name="id" value={image.id} />
    <Button type="submit" size="sm" variant="destructive" disabled={deleted.has(image.id)}>
      {deleted.has(image.id) ? 'Deleted' : 'Delete'}
    </Button>
  </form>
{/snippet}

<ImageQueueGrid
  {items}
  civitaiUrl={data.civitaiUrl}
  nextCursor={data.nextCursor}
  {card}
  itemClass={(image) => (deleted.has(image.id) ? 'opacity-50' : '')}
  empty="No images with missing media."
/>
