<script lang="ts" generics="T extends { id: number; url: string; type: MediaType; nsfwLevel?: number }">
  import { goto } from '$app/navigation';
  import { page as pageState } from '$app/state';
  import type { Snippet } from 'svelte';
  // Used by the `generics=` attribute on the script tag above. ESLint cannot see that as a usage and
  // reports it unused — deleting it is a build error, not a cleanup.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  import type { MediaType } from '$lib/media/edge-url';
  import type { SvelteSet } from 'svelte/reactivity';
  import { IconExternalLink } from '@tabler/icons-svelte';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Card, CardContent } from '@civitai/ui/components/ui/card/index.js';
  import EdgeMedia from '$lib/components/EdgeMedia.svelte';
  import NumberedPager from '$lib/components/NumberedPager.svelte';
  import { readCursorTrail, writeCursorTrail, clearPaging, IMAGE_PAGE_PARAM } from '$lib/paging';
  import { getBrowsingLevelLabel, NsfwLevel } from '@civitai/shared';

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
    total,
    perPage,
    page: pageProp,
    keyOf,
    itemClass,
    card,
    selected,
    empty = 'Nothing to review in this queue.',
    endLabel = 'End of queue.',
    minColumn = 300,
  }: {
    items: T[];
    civitaiUrl: string;
    /** Cursor paging: forward-only, Back walks the trail in the URL. Unused in numbered mode. */
    nextCursor?: number | string;
    /** Numbered paging. Pass all three or none: `page` comes from the SERVER, which clamps it —
     *  re-deriving it from the URL renders a pager pointing at a page the grid is not showing. */
    total?: number;
    perPage?: number;
    page?: number;
    /** Key accessor — defaults to the image id (the reported queue keys by report id). */
    keyOf?: (item: T) => string | number;
    itemClass?: (item: T) => string;
    card: Snippet<[T]>;
    /** Pass a set to enable multiselect: the image becomes the select target and the corner arrow
     *  is the way out to the site. */
    selected?: SvelteSet<string | number>;
    empty?: string;
    /** `null` suppresses the terminator where a capped batch would contradict the truncation warning. */
    endLabel?: string | null;
    /** 300 unless the grid sits beside another column. */
    minColumn?: number;
  } = $props();

  const key = (item: T) => keyOf?.(item) ?? item.id;

  function toggle(item: T) {
    if (!selected) return;
    const k = key(item);
    if (selected.has(k)) selected.delete(k);
    else selected.add(k);
  }

  const numbered = $derived(total != null && perPage != null && pageProp != null);
  const trail = $derived(readCursorTrail(pageState.url.searchParams));
  const pageNumber = $derived(numbered ? (pageProp ?? 1) : trail.length + 1);

  // A `cursor` with no trail beside it — a bookmark, or a link shared before the trail existed — is
  // page 1 by `pageNumber` and can still render empty, which is the one state with no control on it.
  const paged = $derived(pageNumber > 1 || pageState.url.searchParams.has('cursor'));

  function navigate(mutate: (params: URLSearchParams) => void) {
    const url = new URL(pageState.url);
    mutate(url.searchParams);
    goto(url.pathname + url.search);
  }

  const goPage = (n: number) =>
    navigate((params) => {
      if (n <= 1) params.delete(IMAGE_PAGE_PARAM);
      else params.set(IMAGE_PAGE_PARAM, String(n));
    });

  const goNext = () =>
    nextCursor != null &&
    navigate((params) => writeCursorTrail(params, [...trail, String(nextCursor)]));

  const goBack = () => navigate((params) => writeCursorTrail(params, trail.slice(0, -1)));

  const goFirst = () => navigate(clearPaging);
</script>

{#if items.length === 0}
  <div class="placeholder">{empty}</div>
  <!-- A narrowed filter or a deep link can land here with no other control on the page. -->
  {#if paged}
    <div class="mt-4 flex justify-center">
      <Button variant="outline" onclick={goFirst}>Back to the first page</Button>
    </div>
  {/if}
{:else}
  <div class="grid gap-4" style="grid-template-columns: repeat(auto-fill, minmax({minColumn}px, 1fr))">
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

  {#if numbered}
    <NumberedPager
      page={pageNumber}
      total={total ?? 0}
      perPage={perPage ?? 1}
      label="images"
      onPageChange={goPage}
    />
  {:else if nextCursor || endLabel || paged}
    <div class="mt-6 flex flex-wrap items-center justify-center gap-3">
      {#if paged}
        <Button size="lg" variant="outline" onclick={goFirst}>First</Button>
        <Button size="lg" variant="outline" onclick={goBack}>Back</Button>
      {/if}
      {#if paged || nextCursor}
        <span class="text-sm text-dark-2">Page {pageNumber}</span>
      {/if}
      {#if nextCursor}
        <Button size="lg" onclick={goNext}>Next</Button>
      {:else if endLabel}
        <span class="text-sm text-dark-2">{endLabel}</span>
      {/if}
    </div>
  {/if}
{/if}
