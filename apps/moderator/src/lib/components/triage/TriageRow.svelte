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
    metaClass = 'text-dark-2',
    coverUrl,
    coverType,
    coverBlurred = false,
    cover = true,
    coverIcon,
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
    /** Colour of the meta text, e.g. amber for someone waiting. */
    metaClass?: string;
    coverUrl?: string | undefined;
    /** `video` shows the poster frame; anything else, or none, is an image. */
    coverType?: string | null | undefined;
    coverBlurred?: boolean;
    /** False for items with no image, which drops the thumbnail slot. */
    cover?: boolean;
    coverIcon?: Snippet;
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
      'flex gap-2.5 border-l-2 px-3 py-2.5 transition-colors hover:bg-dark-5',
      selected ? 'border-blue-500 bg-dark-5' : 'border-transparent',
      verdict && 'opacity-50'
    )}
  >
    {#if cover}
      <div class="size-11 shrink-0 overflow-hidden rounded-md border border-dark-4 bg-dark-7">
        {#if coverUrl}
          <EdgeMedia
            src={coverUrl}
            type={coverType === 'video' ? 'video' : 'image'}
            anim={coverType === 'video' ? false : undefined}
            width={96}
            class={cn('size-full object-cover', coverBlurred && 'scale-125 blur-md')}
          />
        {:else if coverIcon}
          <div class="grid size-full place-items-center text-dark-2 [&_svg]:size-[18px]">
            {@render coverIcon()}
          </div>
        {/if}
      </div>
    {/if}
    <div class="min-w-0 flex-1">
      <div class="flex items-baseline justify-between gap-2">
        <span class="truncate text-sm font-medium text-white">{title}</span>
        <span class={cn('shrink-0 text-xs tabular-nums', metaClass)}>{meta}</span>
      </div>
      {#if error}
        <p class="m-0 mt-1 text-sm text-red-300">Failed: {error}</p>
      {/if}
      {#if verdict}
        <p class="m-0 mt-1 text-sm text-dark-0">{verdict}</p>
      {:else}
        <div class="mt-1.5 flex flex-wrap items-center gap-1">
          {@render badges()}
        </div>
      {/if}
    </div>
  </a>
</li>
