<script lang="ts">
  import { cn } from '@civitai/ui/utils.js';
  import { IconMusic } from '@tabler/icons-svelte';

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

  const tileClass = 'aspect-square w-full rounded object-cover ring-1 ring-inset ring-dark-4/60';

  // Play on hover, reset on leave — a lightweight preview without autoplaying every tile at once. Full
  // playback (with controls) lives in the fullscreen SampleViewer.
  function play(e: Event) {
    (e.currentTarget as HTMLVideoElement).play().catch(() => {});
  }
  function reset(e: Event) {
    const v = e.currentTarget as HTMLVideoElement;
    v.pause();
    v.currentTime = 0;
  }
</script>

{#if url}
  {#if isAudio}
    <!-- Audio samples aren't a square thumbnail — a full-width player card, so the controls are usable. -->
    <div
      class={cn(
        'flex w-full items-center gap-2.5 rounded-lg border border-dark-4 bg-dark-7 p-3',
        className
      )}
    >
      <IconMusic size={18} stroke={2} class="shrink-0 text-dark-2" />
      <audio src={url} controls preload="metadata" class="h-9 w-full"></audio>
    </div>
  {:else if isVideo}
    <!-- svelte-ignore a11y_media_has_caption -->
    <video
      src={url}
      muted
      loop
      playsinline
      preload="metadata"
      aria-label={alt}
      class={cn(tileClass, className)}
      onmouseenter={play}
      onmouseleave={reset}
    ></video>
  {:else}
    <img src={url} {alt} loading="lazy" class={cn(tileClass, className)} />
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
