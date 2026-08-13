<script lang="ts" generics="T extends { id: number; url: string; type: MediaType; nsfwLevel?: number }">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import type { Snippet } from 'svelte';
  import type { SvelteSet } from 'svelte/reactivity';
  import { IconExternalLink } from '@tabler/icons-svelte';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Card, CardContent } from '@civitai/ui/components/ui/card/index.js';
  import EdgeMedia from '$lib/components/EdgeMedia.svelte';
  import { getBrowsingLevelLabel, NsfwLevel } from '@civitai/shared';
  import type { MediaType } from '$lib/media/edge-url';

  const RATING_BADGE: Record<number, string> = {
    [NsfwLevel.PG]: 'bg-green-600 text-white',
    [NsfwLevel.PG13]: 'bg-yellow-500 text-black',
    [NsfwLevel.R]: 'bg-orange-500 text-white',
    [NsfwLevel.X]: 'bg-red-600 text-white',
    [NsfwLevel.XXX]: 'bg-purple-600 text-white',
    [NsfwLevel.Blocked]: 'bg-rose-800 text-white',
  };

  let {
    items,
    civitaiUrl,
    nextCursor,
    keyOf,
    itemClass,
    card,
    selected,
    empty = 'Nothing to review in this queue.',
    endLabel = 'End of queue.',
  }: {
    items: T[];
    civitaiUrl: string;
    nextCursor?: number | string;
    /** Key accessor — defaults to the image id (the reported queue keys by report id). */
    keyOf?: (item: T) => string | number;
    itemClass?: (item: T) => string;
    card: Snippet<[T]>;
    /** Pass a set to enable multiselect. The image itself then becomes the select target and the
     *  corner arrow is the way out to the site — selecting is the gesture these pages are for, and
     *  making it the secondary one cost a navigation on the first click of every batch. */
    selected?: SvelteSet<string | number>;
    empty?: string;
    /** `null` suppresses the terminator — for a capped batch, where "End of queue." would contradict
     *  the page's own truncation warning. */
    endLabel?: string | null;
  } = $props();

  const key = (item: T) => keyOf?.(item) ?? item.id;

  function toggle(item: T) {
    const k = key(item);
    if (selected!.has(k)) selected!.delete(k);
    else selected!.add(k);
  }

  function goNext() {
    if (nextCursor == null) return;
    const url = new URL(page.url);
    url.searchParams.set('cursor', String(nextCursor));
    goto(url.pathname + url.search);
  }
</script>

{#if items.length === 0}
  <div class="placeholder">{empty}</div>
{:else}
  <div class="grid gap-4" style="grid-template-columns: repeat(auto-fill, minmax(300px, 1fr))">
    {#each items as item (key(item))}
      {@const isSelected = selected?.has(key(item)) ?? false}
      <Card
        class="gap-0 overflow-hidden p-0 transition-opacity {itemClass?.(item) ?? ''} {isSelected
          ? 'ring-2 ring-primary ring-offset-1'
          : ''}"
      >
        <div class="relative flex aspect-[4/5] items-center justify-center overflow-hidden bg-muted">
          {#if selected}
            <button
              type="button"
              onclick={() => toggle(item)}
              aria-pressed={isSelected}
              aria-label={isSelected ? 'Deselect image' : 'Select image'}
              class="flex h-full w-full cursor-pointer items-center justify-center"
            >
              <EdgeMedia
                src={item.url}
                type={item.type}
                width={450}
                class="max-h-full max-w-full object-contain"
              />
            </button>
            <a
              href={`${civitaiUrl}/images/${item.id}`}
              target="_blank"
              rel="noreferrer"
              title="Open on Civitai"
              aria-label="Open on Civitai"
              class="absolute bottom-2 right-2 z-10 rounded bg-black/70 p-1.5 text-white hover:bg-black/90"
            >
              <IconExternalLink size={16} />
            </a>
          {:else}
            <a
              href={`${civitaiUrl}/images/${item.id}`}
              target="_blank"
              rel="noreferrer"
              class="flex h-full w-full items-center justify-center"
            >
              <EdgeMedia
                src={item.url}
                type={item.type}
                width={450}
                class="max-h-full max-w-full object-contain"
              />
            </a>
          {/if}
          {#if item.nsfwLevel != null}
            <Badge
              class="absolute left-2 top-2 border-transparent {RATING_BADGE[item.nsfwLevel] ??
                'bg-black/70 text-white'}"
            >
              {getBrowsingLevelLabel(item.nsfwLevel)}
            </Badge>
          {/if}
          {#if selected}
            <input
              type="checkbox"
              checked={isSelected}
              onchange={() => toggle(item)}
              aria-label="Select image"
              class="absolute right-2 top-2 z-10 size-5 cursor-pointer accent-primary"
            />
          {/if}
        </div>
        <CardContent class="flex flex-col gap-2 p-2.5">
          {@render card(item)}
        </CardContent>
      </Card>
    {/each}
  </div>

  {#if nextCursor || endLabel}
    <div class="mt-6 flex justify-center">
      {#if nextCursor}
        <Button size="lg" onclick={goNext}>Next</Button>
      {:else}
        <span class="text-sm text-dark-2">{endLabel}</span>
      {/if}
    </div>
  {/if}
{/if}
