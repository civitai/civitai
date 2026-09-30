<script lang="ts">
  import { cn } from '@civitai/ui/utils.js';
  import { IconMusic } from '@tabler/icons-svelte';
  import { untrack } from 'svelte';
  import { sameBlob } from '$lib/stable-src';

  let {
    url,
    alt = 'training sample',
    isVideo = false,
    isAudio = false,
    pending = null,
    class: className = '',
  }: {
    url: string | null;
    alt?: string;
    isVideo?: boolean;
    isAudio?: boolean;
    /** How to read a missing sample: `true` = the run is still training (the sample is being
     *  generated), `false` = the run is terminal (this sample will never arrive — it failed),
     *  `null` = unknown, render the neutral placeholder. */
    pending?: boolean | null;
    class?: string;
  } = $props();

  // The detail page re-reads the run every few seconds while training, and each read re-signs the
  // sample URLs. Handing that fresh URL to a playing <audio>/<video> reloads it and stops playback, so
  // hold the URL we rendered until the blob itself changes — or the held signature stops working.
  let src = $state(untrack(() => url));
  $effect.pre(() => {
    const next = url;
    untrack(() => {
      if (!src || !next || !sameBlob(src, next)) src = next;
    });
  });
  function refreshExpired() {
    if (url && src !== url) src = url;
  }

  const tileClass = 'aspect-square w-full rounded object-cover ring-1 ring-inset ring-dark-4/60';

  // Play on hover, reset on leave — a lightweight preview without autoplaying every tile at once. Full
  // playback (with controls) lives in the fullscreen SampleViewer.
  import { playOnHover as play, resetOnLeave as reset } from '$lib/video-preview';
</script>

{#if src}
  {#if isAudio}
    <!-- Audio samples aren't a square thumbnail — a full-width player card, so the controls are usable. -->
    <div
      class={cn(
        'flex w-full items-center gap-2.5 rounded-lg border border-dark-4 bg-dark-7 p-3',
        className
      )}
    >
      <IconMusic size={18} stroke={2} class="shrink-0 text-dark-2" />
      <audio {src} controls preload="metadata" class="h-9 w-full" onerror={refreshExpired}></audio>
    </div>
  {:else if isVideo}
    <!-- svelte-ignore a11y_media_has_caption -->
    <video
      {src}
      muted
      loop
      playsinline
      preload="metadata"
      aria-label={alt}
      class={cn(tileClass, className)}
      onmouseenter={play}
      onmouseleave={reset}
      onerror={refreshExpired}
    ></video>
  {:else}
    <img {src} {alt} loading="lazy" class={cn(tileClass, className)} onerror={refreshExpired} />
  {/if}
{:else}
  {@const tone =
    pending === true
      ? { cls: 'animate-pulse border-dark-4 text-dark-2', label: 'generating…' }
      : pending === false
        ? { cls: 'border-red-500/25 text-red-400/80', label: 'sample failed' }
        : {
            cls: 'border-dark-4 text-dark-2',
            label: `no ${isAudio ? 'audio' : isVideo ? 'video' : 'image'}`,
          }}
  <div
    class={cn(
      'grid aspect-square w-full place-items-center rounded border border-dashed bg-dark-7 font-mono text-xs',
      tone.cls,
      className
    )}
  >
    {tone.label}
  </div>
{/if}
