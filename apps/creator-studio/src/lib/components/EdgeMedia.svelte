<script lang="ts">
  import { getInferredMediaType, type EdgeUrlOptions } from '$lib/media/edge-url';
  import EdgeImage from './EdgeImage.svelte';
  import EdgeVideo from './EdgeVideo.svelte';

  type Props = EdgeUrlOptions & {
    /** Cloudflare-images key — the Image row's `url`/GUID column (NOT the numeric id). */
    src: string;
    /** Used (with `type`) to infer image vs video when `type` is not given. */
    name?: string | null;
    thumbnailUrl?: string | null;
    threshold?: number;
    muted?: boolean;
    alt?: string;
    class?: string;
  };

  let { src, name, type, thumbnailUrl, threshold, muted, alt, class: className, ...options }: Props =
    $props();

  const resolved = $derived(getInferredMediaType(src, { name, type }));
</script>

{#if resolved === 'video'}
  <EdgeVideo {src} {name} {thumbnailUrl} {threshold} {muted} class={className} {...options} />
{:else}
  <EdgeImage {src} {name} type="image" {alt} class={className} {...options} />
{/if}
