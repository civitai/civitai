<script lang="ts">
  import { cn } from '@civitai/ui/utils.js';
  import { IconMusic } from '@tabler/icons-svelte';

  let {
    url,
    alt = 'training sample',
    isVideo = false,
    isAudio = false,
    class: className = '',
  }: {
    url: string | null;
    alt?: string;
    isVideo?: boolean;
    isAudio?: boolean;
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
  <div
    class={cn(
      'grid aspect-square w-full place-items-center rounded border border-dashed border-dark-4 bg-dark-7 font-mono text-[10px] text-dark-2',
      className
    )}
  >
    no {isAudio ? 'audio' : isVideo ? 'video' : 'image'}
  </div>
{/if}
