<script lang="ts">
  import EdgeMedia from '$lib/components/EdgeMedia.svelte';
  import { getInferredMediaType, type MediaType } from '$lib/media/edge-url';
  import {
    MEDIA_UNPROCESSED,
    probeRetractedRefusal,
    RETRACTED_REFUSED,
    retractedMediaUrl,
  } from '$lib/held-media';

  // The public CDN first. Media it will not serve (a blocked image or video) is tried once more from
  // storage through `/api/retracted-media`, which decides on the server whether this moderator may see
  // it. Storage has the original only, so that copy is full size.
  let {
    item,
    width = 450,
    alt = '',
    class: className,
    unprocessed = false,
  }: {
    item: { id: number; url: string; type?: MediaType | null; name?: string | null };
    width?: number;
    alt?: string;
    class?: string;
    /** The upload never finished processing, so storage has no file to fall back to either. */
    unprocessed?: boolean;
  } = $props();

  const mediaType = $derived(
    getInferredMediaType(item.url, { name: item.name, type: item.type ?? undefined })
  );

  // Per id, so an instance reused for another image starts on the CDN again.
  let fallback = $state<{ id: number; mode: 'retracted' | 'failed'; reason: string } | null>(null);
  const mode = $derived(fallback?.id === item.id ? fallback.mode : 'cdn');

  const toStorage = (id: number) => {
    if (fallback?.id === id) return;
    fallback = unprocessed
      ? { id, mode: 'failed', reason: MEDIA_UNPROCESSED }
      : { id, mode: 'retracted', reason: RETRACTED_REFUSED };
  };

  // `error` does not bubble, so it is caught on the way down. A video reports each failed `<source>`,
  // and only the last one means nothing played.
  const onCdnError = (event: Event) => {
    const target = event.target;
    if (target instanceof HTMLSourceElement && target.nextElementSibling) return;
    toStorage(item.id);
  };

  // Server-rendered media can fail before hydration attaches the listener, so check once on mount. A
  // just-inserted video reads NO_SOURCE until its source selection starts, so that check waits a task.
  function probe(span: HTMLSpanElement) {
    const id = item.id;
    const media = span.querySelector('img, video');
    if (media instanceof HTMLImageElement && media.complete && media.naturalWidth === 0) toStorage(id);
    if (!(media instanceof HTMLVideoElement)) return;
    const timer = setTimeout(() => {
      if (media.networkState === HTMLMediaElement.NETWORK_NO_SOURCE) toStorage(id);
    });
    return () => clearTimeout(timer);
  }

  // The route's reason, when it gives one a moderator can act on; nothing is served by a probe.
  const onRetractedError = () => {
    const id = item.id;
    fallback = { id, mode: 'failed', reason: RETRACTED_REFUSED };
    probeRetractedRefusal(id)
      .then((reason) => {
        if (fallback?.id === id) fallback = { id, mode: 'failed', reason };
      })
      .catch(() => null);
  };
</script>

{#if mode === 'failed'}
  <div class="p-4 text-center text-xs text-dark-2">{fallback?.reason}</div>
{:else if mode === 'retracted' && mediaType === 'video'}
  <!-- Controls, as it does not autoplay here. -->
  <video
    src={retractedMediaUrl(item.id)}
    class={className}
    muted
    playsinline
    controls
    preload="metadata"
    onerror={onRetractedError}
  ></video>
{:else if mode === 'retracted'}
  <img
    src={retractedMediaUrl(item.id)}
    {alt}
    loading="lazy"
    decoding="async"
    class={className}
    onerror={onRetractedError}
  />
{:else}
  <span class="contents" onerrorcapture={onCdnError} {@attach probe}>
    <EdgeMedia
      src={item.url}
      name={item.name}
      type={mediaType}
      {width}
      {alt}
      class={className}
    />
  </span>
{/if}
