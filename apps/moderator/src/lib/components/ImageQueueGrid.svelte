<script lang="ts" generics="T extends { id: number; url: string; type: MediaType }">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import type { Snippet } from 'svelte';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Card, CardContent } from '@civitai/ui/components/ui/card/index.js';
  import EdgeMedia from '$lib/components/EdgeMedia.svelte';
  import type { MediaType } from '$lib/media/edge-url';

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
    empty?: string;
  } = $props();

  const key = (item: T) => keyOf?.(item) ?? item.id;

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
      <Card class="gap-0 overflow-hidden p-0 transition-opacity {itemClass?.(item) ?? ''}">
        <div class="flex aspect-[4/5] items-center justify-center overflow-hidden bg-muted">
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
