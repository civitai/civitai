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

  let mode = $state<'cdn' | 'retracted' | 'failed'>('cdn');
  let reason = $state('Not viewable here');

  // The route's reason, when it gives one a moderator can act on; nothing is served by a probe.
  const onRetractedError = () => {
    mode = 'failed';
    fetch(`${retractedMediaUrl(item.id)}?probe=1`)
      .then(async (res) => {
        if (res.status !== 403) return;
        const body = (await res.json()) as { message?: unknown };
        if (typeof body.message === 'string' && body.message) reason = body.message;
      })
      .catch(() => null);
  };
</script>

{#if mode === 'failed'}
  <div class="p-4 text-center text-xs text-dark-2">{reason}</div>
{:else if mode === 'retracted'}
  <img
    src={retractedMediaUrl(item.id)}
    alt=""
    loading="lazy"
    decoding="async"
    class={className}
    onerror={onRetractedError}
  />
{:else}
  <EdgeMedia
    src={item.url}
    type={item.type}
    width={450}
    class={className}
    onerror={item.type === 'image' ? () => (mode = 'retracted') : undefined}
  />
{/if}
