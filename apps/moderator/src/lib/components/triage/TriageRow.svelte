<script lang="ts">
  import type { Snippet } from 'svelte';
  import { cn } from '@civitai/ui/utils.js';
  import EdgeMedia from '$lib/components/EdgeMedia.svelte';

  let {
    id,
    href,
    selected,
    title,
    meta,
    coverUrl,
    cover = true,
    verdict,
    error,
    onselect,
    badges,
  }: {
    id: string;
    href: string;
    selected: boolean;
    title: string;
    /** Short text on the right of the title, e.g. how long it has waited. */
    meta: string;
    coverUrl?: string | undefined;
    /** False for items with no image, which drops the thumbnail slot. */
    cover?: boolean;
    verdict: string | undefined;
    error: string | undefined;
    onselect: () => void;
    badges: Snippet;
  } = $props();

  const onclick = (e: MouseEvent) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    onselect();
  };
</script>

<li {id}>
  <a
    {href}
    {onclick}
    aria-current={selected ? 'true' : undefined}
    class={cn(
      'flex gap-3 border-l-2 px-3 py-2.5 transition-colors hover:bg-dark-5',
      selected ? 'border-blue-500 bg-dark-5' : 'border-transparent',
      verdict && 'opacity-50'
    )}
  >
    {#if cover}
      <div class="size-11 shrink-0 overflow-hidden rounded-md border border-dark-4 bg-dark-7">
        {#if coverUrl}
          <EdgeMedia src={coverUrl} type="image" width={96} class="size-full object-cover" />
        {/if}
      </div>
    {/if}
    <div class="min-w-0 flex-1">
      <div class="flex items-baseline justify-between gap-2">
        <span class="truncate text-sm font-medium text-white">{title}</span>
        <span class="shrink-0 text-xs text-dark-2 tabular-nums">{meta}</span>
      </div>
      {#if error}
        <p class="m-0 mt-1 text-sm text-red-300">Failed: {error}</p>
      {/if}
      {#if verdict}
        <p class="m-0 mt-1 text-sm text-dark-0">{verdict}</p>
      {:else}
        <div class="mt-1 flex flex-wrap items-center gap-1">
          {@render badges()}
        </div>
      {/if}
    </div>
  </a>
</li>
