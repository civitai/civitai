<script lang="ts" generics="T extends { id: number; url: string; type: MediaType; nsfwLevel?: number }">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import type { Snippet } from 'svelte';
  import type { SvelteSet } from 'svelte/reactivity';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Card, CardContent } from '@civitai/ui/components/ui/card/index.js';
  import EdgeMedia from '$lib/components/EdgeMedia.svelte';
  import { getBrowsingLevelLabel, NsfwLevel } from '@civitai/shared';
  import type { MediaType } from '$lib/media/edge-url';

  // nsfwLevel → rating-badge color, matching the legacy `nsfwLevelColors`
  // (PG green, PG13 yellow, R orange, X red, XXX grape). Solid backgrounds so the badge reads over
  // any image; unknown/unrated levels fall back to neutral.
  const RATING_BADGE: Record<number, string> = {
    [NsfwLevel.PG]: 'bg-green-600 text-white',
    [NsfwLevel.PG13]: 'bg-yellow-500 text-black',
    [NsfwLevel.R]: 'bg-orange-500 text-white',
    [NsfwLevel.X]: 'bg-red-600 text-white',
    [NsfwLevel.XXX]: 'bg-purple-600 text-white',
    [NsfwLevel.Blocked]: 'bg-rose-800 text-white',
  };

  // The shared image-queue card + grid: a 300px auto-fill grid of large aspect-[4/5] cards (image links
  // to the main app) with cursor-paged Next. The card body is the consumer's — moderation review detail,
  // action forms, whatever — supplied via the `card` snippet. Header/filters live in the page, above this.
  let {
    items,
    civitaiUrl,
    nextCursor,
    keyOf,
    itemClass,
    card,
    selected,
    empty = 'Nothing to review in this queue.',
  }: {
    items: T[];
    civitaiUrl: string;
    // Number (id-based queues) or string (e.g. ClickHouse offset cursors).
    nextCursor?: number | string;
    // Key accessor — defaults to the image id (the reported queue keys by report id).
    keyOf?: (item: T) => string | number;
    // Optional per-card class (e.g. optimistic dimming on an actioned card).
    itemClass?: (item: T) => string;
    // Card body, rendered inside CardContent under the image.
    card: Snippet<[T]>;
    // Pass a set to enable multiselect: a top-right checkbox per card, and once anything is selected an
    // image click toggles instead of navigating. The set (page-owned) is keyed the same as `keyOf`.
    selected?: SvelteSet<string | number>;
    empty?: string;
  } = $props();

  const key = (item: T) => keyOf?.(item) ?? item.id;

  function toggle(item: T) {
    const k = key(item);
    if (selected!.has(k)) selected!.delete(k);
    else selected!.add(k);
  }

  // In selection mode (≥1 selected) an image click toggles the card instead of opening the link.
  function onImageClick(e: MouseEvent, item: T) {
    if (selected && selected.size > 0) {
      e.preventDefault();
      toggle(item);
    }
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
          <a
            href={`${civitaiUrl}/images/${item.id}`}
            target="_blank"
            rel="noreferrer"
            class="flex h-full w-full items-center justify-center"
            onclick={(e) => onImageClick(e, item)}
          >
            <EdgeMedia
              src={item.url}
              type={item.type}
              width={450}
              class="max-h-full max-w-full object-contain"
            />
          </a>
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

  <div class="mt-6 flex justify-center">
    {#if nextCursor}
      <Button size="lg" onclick={goNext}>Next</Button>
    {:else}
      <span class="text-sm text-muted-foreground">End of queue.</span>
    {/if}
  </div>
{/if}
