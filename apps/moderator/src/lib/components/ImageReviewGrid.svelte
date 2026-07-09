<script
  lang="ts"
  generics="T extends { id: number; url: string; type: MediaType; nsfwLevel: number; username: string | null }"
>
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import type { Snippet } from 'svelte';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Card, CardContent } from '@civitai/ui/components/ui/card/index.js';
  import EdgeMedia from '$lib/components/EdgeMedia.svelte';
  import { browsingLevels, getBrowsingLevelLabel, NsfwLevel } from '@civitai/shared';
  import type { MediaType } from '$lib/media/edge-url';

  let {
    title,
    items,
    level,
    civitaiUrl,
    nextCursor,
    detail,
    keyOf,
  }: {
    title: string;
    items: T[];
    level: number;
    civitaiUrl: string;
    nextCursor?: number;
    // Per-mode card body, rendered under the image + user header.
    detail: Snippet<[T]>;
    // Key accessor — defaults to the image id, but the reported queue keys by report id (an image can
    // appear once per report).
    keyOf?: (item: T) => string | number;
  } = $props();

  const key = (item: T) => keyOf?.(item) ?? item.id;

  // Moderators filter on Blocked too (a mis-rated image can carry the Blocked bit).
  const filterLevels = [...browsingLevels, NsfwLevel.Blocked];

  function navigate(params: Record<string, string | number | null>) {
    const url = new URL(page.url);
    for (const [k, v] of Object.entries(params)) {
      if (v === null || v === '') url.searchParams.delete(k);
      else url.searchParams.set(k, String(v));
    }
    goto(url.pathname + url.search);
  }

  const toggleLevel = (bit: number) => navigate({ level: level ^ bit, cursor: null });
</script>

<header class="page-header flex flex-wrap items-center justify-between gap-2">
  <h1>{title}</h1>
  <div class="flex items-center gap-1">
    {#each filterLevels as bit (bit)}
      {@const on = (level & bit) !== 0}
      <button
        class="rounded border px-2 py-1 text-xs font-semibold transition {on
          ? 'border-primary bg-primary text-primary-foreground'
          : 'border-border text-muted-foreground hover:border-muted-foreground'}"
        onclick={() => toggleLevel(bit)}
      >
        {getBrowsingLevelLabel(bit)}
      </button>
    {/each}
  </div>
</header>

{#if items.length === 0}
  <div class="placeholder">No images to review in this queue.</div>
{:else}
  <div class="grid gap-4" style="grid-template-columns: repeat(auto-fill, minmax(300px, 1fr))">
    {#each items as item (key(item))}
      <Card class="gap-0 overflow-hidden p-0">
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
        <CardContent class="flex flex-col gap-2 p-2.5 text-sm">
          <div class="flex items-center justify-between gap-2 text-xs text-muted-foreground">
            <a
              href={`${civitaiUrl}/user/${item.username}`}
              target="_blank"
              rel="noreferrer"
              class="truncate hover:text-foreground"
            >
              {item.username ?? '[deleted]'}
            </a>
            <span class="shrink-0">{getBrowsingLevelLabel(item.nsfwLevel)}</span>
          </div>
          {@render detail(item)}
        </CardContent>
      </Card>
    {/each}
  </div>

  <div class="mt-6 flex justify-center">
    {#if nextCursor}
      <Button size="lg" onclick={() => navigate({ cursor: nextCursor ?? null })}>Next</Button>
    {:else}
      <span class="text-sm text-muted-foreground">End of queue.</span>
    {/if}
  </div>
{/if}
