<script lang="ts">
  import { applyAction, enhance } from '$app/forms';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { SvelteMap } from 'svelte/reactivity';
  import type { SubmitFunction } from '@sveltejs/kit';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import EdgeMedia from '$lib/components/EdgeMedia.svelte';
  import { ingestionErrorLevels, getBrowsingLevelLabel } from '$lib/browsing-levels';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  // Chosen level per resolved image — dims the card + highlights the pick, no refetch (mods blast the
  // queue). Reset on a real navigation (limit/cursor change gives new data).
  const resolved = new SvelteMap<number, number>();
  $effect(() => {
    data.items;
    resolved.clear();
  });

  function urlWith(params: Record<string, string | number | null>) {
    const url = new URL(page.url);
    for (const [k, v] of Object.entries(params)) {
      if (v === null) url.searchParams.delete(k);
      else url.searchParams.set(k, String(v));
    }
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
        onclick={() => n !== data.limit && goto(urlWith({ limit: n, cursor: null }))}
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

{#if data.items.length === 0}
  <div class="placeholder">No ingestion errors to review.</div>
{:else}
  <div class="grid gap-6" style="grid-template-columns: repeat(auto-fit, 300px)">
    {#each data.items as image (image.id)}
      <div class="flex flex-col overflow-hidden rounded-xl border" class:opacity-50={resolved.has(image.id)}>
        <form method="POST" action="?/resolve" use:enhance={resolveImage(image.id)}>
          <input type="hidden" name="id" value={image.id} />
          <div class="flex flex-wrap gap-1 p-2">
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
        <a href={`${data.civitaiUrl}/images/${image.id}`} target="_blank" rel="noreferrer">
          <EdgeMedia
            src={image.url}
            type={image.type}
            name={image.name}
            width={450}
            alt={image.name ?? `Image ${image.id}`}
            class="w-full"
          />
        </a>
      </div>
    {/each}
  </div>

  {#if data.nextCursor}
    <div class="mt-6 flex justify-center">
      <Button size="lg" onclick={() => goto(urlWith({ cursor: data.nextCursor ?? null }))}>Next</Button>
    </div>
  {:else}
    <p class="mt-6 text-center text-sm text-muted-foreground">End of queue.</p>
  {/if}
{/if}
