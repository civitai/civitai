<script lang="ts">
  import { applyAction, enhance } from '$app/forms';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { SvelteMap } from 'svelte/reactivity';
  import type { SubmitFunction } from '@sveltejs/kit';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import ImageQueueGrid from '$lib/components/ImageQueueGrid.svelte';
  import { ingestionErrorLevels, getBrowsingLevelLabel } from '@civitai/shared';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();
  // These images are all nsfwLevel 0 (unrated) — strip it so the grid doesn't draw a meaningless
  // rating badge; the mod is here to assign the level.
  type Item = Omit<PageData['items'][number], 'nsfwLevel'>;

  // Chosen level per resolved image — dims the card + highlights the pick, no refetch (mods blast the
  // queue). Reset on a real navigation (limit/cursor change gives new data).
  const resolved = new SvelteMap<number, number>();
  $effect(() => {
    data.items;
    resolved.clear();
  });

  const items = $derived(data.items.map(({ nsfwLevel, ...rest }) => rest));

  function limitHref(n: number) {
    const url = new URL(page.url);
    url.searchParams.set('limit', String(n));
    url.searchParams.delete('cursor');
    return url.pathname + url.search;
  }

  const resolveImage =
    (id: number): SubmitFunction =>
    () =>
    async ({ result }) => {
      if (result.type === 'success') {
        const level = (result.data as { nsfwLevel?: number } | undefined)?.nsfwLevel;
        if (level != null) resolved.set(id, level);
      } else {
        await applyAction(result);
      }
    };
</script>

<header class="page-header">
  <h1>Ingestion Error Review</h1>
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
  <div class="mb-4 rounded-md border border-red-500/30 bg-red-500/10 p-2 text-sm text-red-300">
    {form.error}
  </div>
{/if}

{#snippet card(image: Item)}
  <form method="POST" action="?/resolve" use:enhance={resolveImage(image.id)}>
    <input type="hidden" name="id" value={image.id} />
    <div class="flex flex-wrap gap-1">
      {#each ingestionErrorLevels as level (level)}
        <Button
          type="submit"
          name="nsfwLevel"
          value={level}
          size="sm"
          variant={resolved.get(image.id) === level ? 'default' : 'outline'}
          class={resolved.get(image.id) === level ? 'bg-teal-600 hover:bg-teal-600' : ''}
        >
          {getBrowsingLevelLabel(level)}
        </Button>
      {/each}
    </div>
  </form>
{/snippet}

<ImageQueueGrid
  {items}
  civitaiUrl={data.civitaiUrl}
  nextCursor={data.nextCursor}
  {card}
  itemClass={(image) => (resolved.has(image.id) ? 'opacity-50' : '')}
  empty="No ingestion errors to review."
/>
