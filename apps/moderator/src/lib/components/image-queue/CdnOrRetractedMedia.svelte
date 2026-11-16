<script lang="ts">
  import EdgeMedia from '$lib/components/EdgeMedia.svelte';
  import type { MediaType } from '$lib/media/edge-url';
  import { retractedMediaUrl } from '$lib/held-media';

  // The public CDN first. An image it will not serve (a blocked one) is tried once more from storage
  // through `/api/retracted-media`, which decides on the server whether this moderator may see it.
  // Videos load through <source> children, whose failures the element does not report, so a video
  // stays on the CDN.
  let {
    item,
    class: className,
  }: { item: { id: number; url: string; type: MediaType }; class?: string } = $props();

  let state = $state<'cdn' | 'retracted' | 'failed'>('cdn');
</script>

{#if state === 'failed'}
  <div class="p-4 text-center text-xs text-dark-2">Not viewable here</div>
{:else if state === 'retracted'}
  <img
    src={retractedMediaUrl(item.id)}
    alt=""
    loading="lazy"
    decoding="async"
    class={className}
    onerror={() => (state = 'failed')}
  />
{:else}
  <EdgeMedia
    src={item.url}
    type={item.type}
    width={450}
    class={className}
    onerror={item.type === 'image' ? () => (state = 'retracted') : undefined}
  />
{/if}
