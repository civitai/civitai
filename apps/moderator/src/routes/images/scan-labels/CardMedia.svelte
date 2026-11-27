<script lang="ts">
  let {
    type,
    mediaSrc,
    width,
    height,
    failed = $bindable(false),
  }: {
    type: string;
    mediaSrc: string;
    width: number | null;
    height: number | null;
    failed?: boolean;
  } = $props();

  // Mounted per card (the parent keys it), so the state starts fresh for each one.
  let ready = $state(false);
  const noun = $derived(type === 'video' ? 'Video' : 'Image');

  const SOURCE_SELECTION_WAIT_MS = 250;
  const fail = () => (failed = true);
  const markReady = () => (ready = true);

  // Svelte does not replay <video> events from before hydration, so read where it already got to.
  // NETWORK_NO_SOURCE only well after mount: a new <video> reads it until its source selection starts
  // a task later, so read at once it would mark every client-rendered card failed.
  let video = $state<HTMLVideoElement | null>(null);
  $effect(() => {
    if (!video) return;
    const el = video;
    if (el.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) ready = true;
    const timer = setTimeout(() => {
      if (el.networkState === HTMLMediaElement.NETWORK_NO_SOURCE) failed = true;
    }, SOURCE_SELECTION_WAIT_MS);
    return () => clearTimeout(timer);
  });
</script>

<!-- Listeners sit on the media elements, not a wrapper: Svelte replays an <img> load or error that
     fired before hydration only for an element with its own handler. -->
<div class="relative flex min-h-40 justify-center">
  <!-- Served by the card's token, so the page never names the media itself. -->
  {#if type === 'video'}
    <video
      bind:this={video}
      class="max-h-[75vh] w-auto max-w-full rounded-lg object-contain"
      poster="{mediaSrc}?v=poster"
      autoplay
      muted
      loop
      controls
      playsinline
      preload="metadata"
      onloadeddata={markReady}
      oncanplay={markReady}
      onerror={fail}
    >
      <!-- A <source> error fires per candidate; only the last one means nothing can play. -->
      <source src="{mediaSrc}?v=webm" type="video/webm" />
      <source src="{mediaSrc}?v=mp4" type="video/mp4" onerror={fail} />
    </video>
  {:else if !failed}
    <!-- Neutral alt: a broken image shows its alt, which must never read as a status. -->
    <img
      src="{mediaSrc}?v=image"
      alt="Card media"
      width={width ?? undefined}
      height={height ?? undefined}
      decoding="async"
      onerror={fail}
      class="max-h-[75vh] w-auto max-w-full rounded-lg object-contain"
    />
  {/if}
  {#if failed || (type === 'video' && !ready)}
    <div
      class="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-dark-2"
      role="status"
    >
      <span class="rounded-md bg-dark-8/80 px-3 py-1.5">
        {failed ? `${noun} failed to load` : 'Loading video...'}
      </span>
    </div>
  {/if}
</div>
