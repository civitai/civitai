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
  <p class="mt-1 text-xs text-muted-foreground">
    The file behind these images could not be fetched, so they can never be scanned and must not be
    published — publishing one puts a permanently broken image on the site. Delete them, or ask the
    uploader to upload again.
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
