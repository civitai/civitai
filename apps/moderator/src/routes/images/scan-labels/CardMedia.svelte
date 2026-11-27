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

  // A <source> error fires per candidate; only the last one (or the <video>) means nothing can play.
  const onError = (e: Event) => {
    const el = e.target as HTMLElement;
    if (el.tagName === 'IMG' || el.tagName === 'VIDEO') failed = true;
    else if (el.tagName === 'SOURCE' && !el.nextElementSibling) failed = true;
  };
</script>

<!-- Media events do not bubble; capture on the wrapper hears the inner <video>. -->
<div
  class="relative flex min-h-40 justify-center"
  onloadcapture={() => (ready = true)}
  onloadeddatacapture={() => (ready = true)}
  oncanplaycapture={() => (ready = true)}
  onerrorcapture={onError}
>
  <!-- Served by the card's token, so the page never names the media itself. -->
  {#if type === 'video'}
    <video
      class="max-h-[75vh] w-auto max-w-full rounded-lg object-contain"
      poster="{mediaSrc}?v=poster"
      autoplay
      muted
      loop
      controls
      playsinline
      preload="metadata"
    >
      <source src="{mediaSrc}?v=webm" type="video/webm" />
      <source src="{mediaSrc}?v=mp4" type="video/mp4" />
    </video>
  {:else if !failed}
    <!-- Neutral alt: a broken image shows its alt, which must never read as a status. -->
    <img
      src="{mediaSrc}?v=image"
      alt="Card media"
      width={width ?? undefined}
      height={height ?? undefined}
      decoding="async"
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
