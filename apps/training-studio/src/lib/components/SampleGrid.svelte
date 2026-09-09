<script lang="ts">
  import { cn } from '@civitai/ui/utils.js';

  let {
    urls,
    cols = 4,
    isVideo = false,
    class: className = '',
  }: { urls: string[]; cols?: number; isVideo?: boolean; class?: string } = $props();

  const colClass: Record<number, string> = {
    2: 'grid-cols-2',
    3: 'grid-cols-3',
    4: 'grid-cols-4',
    6: 'grid-cols-6',
  };
  const tileClass = 'aspect-square w-full rounded object-cover ring-1 ring-inset ring-dark-4/60';

  function play(e: Event) {
    (e.currentTarget as HTMLVideoElement).play().catch(() => {});
  }
  function reset(e: Event) {
    const v = e.currentTarget as HTMLVideoElement;
    v.pause();
    v.currentTime = 0;
  }
</script>

<div class={cn('grid gap-1.5', colClass[cols] ?? 'grid-cols-4', className)}>
  {#each urls as url, i (i)}
    {#if isVideo}
      <!-- svelte-ignore a11y_media_has_caption -->
      <video
        src={url}
        muted
        loop
        playsinline
        preload="metadata"
        aria-label="training sample"
        class={tileClass}
        onmouseenter={play}
        onmouseleave={reset}
      ></video>
    {:else}
      <img src={url} alt="training sample" loading="lazy" class={tileClass} />
    {/if}
  {/each}
</div>
