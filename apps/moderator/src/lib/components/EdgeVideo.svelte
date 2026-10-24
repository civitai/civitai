<script lang="ts">
  import type { HTMLVideoAttributes } from 'svelte/elements';
  import { IconPlayerPlayFilled } from '@tabler/icons-svelte';
  import { getVideoUrls, type EdgeUrlOptions } from '$lib/media/edge-url';

  type Props = Omit<HTMLVideoAttributes, 'src' | 'poster' | 'width' | 'height'> &
    EdgeUrlOptions & {
      /** Cloudflare-images key — the Image row's `url`/GUID column (NOT the numeric id). */
      src: string;
      thumbnailUrl?: string | null;
      /** Visibility fraction to auto-play/pause at (default 0.5). Ignored when `anim` is false. */
      threshold?: number;
      /** Muted is required for reliable autoplay; override only if you also surface controls. */
      muted?: boolean;
      /** With `anim={false}`: start playing after the pointer rests on it for a second. */
      hoverPlay?: boolean;
    };

  let {
    src,
    thumbnailUrl,
    threshold = 0.5,
    muted = true,
    hoverPlay = true,
    name,
    width,
    height,
    fit,
    blur,
    quality,
    gravity,
    metadata,
    background,
    gamma,
    optimized,
    skip,
    /**
     * Whether the video plays by itself, as the main app's `EdgeVideo` reads `options.anim`.
     *
     * TRUE (the default here, and every caller's behaviour before this prop meant anything): autoplay
     * while in view, pause out of it, loop.
     *
     * FALSE: never plays by itself. Shows its poster with a play icon, fetches nothing until asked
     * (`preload="none"`), plays after a second's hover (`hoverPlay`), and does not loop. A click is
     * NOT handled here: as in the main app, without `controls` it bubbles to whatever wraps the video
     * (a button opening a lightbox, a link); pass `controls` for the browser's own player. For a GRID of
     * videos: autoplaying a dozen at once decoded them all together, and every loop started the decode
     * again — the model reports preview froze the page that way.
     *
     * ⚠️ THE DEFAULT IS THE OPPOSITE OF THE MAIN APP'S, where an unset `anim` does not autoplay. Here
     * every caller was written against autoplay, so flipping the default would have silently stilled
     * them all. Opt out per call site.
     */
    anim = true,
    // transcode/type/original are fixed by getVideoUrls — absorb them so they don't leak onto the
    // <video> DOM element via ...rest.
    transcode: _transcode,
    type: _type,
    original: _original,
    class: className,
    ...rest
  }: Props = $props();

  const urls = $derived(
    getVideoUrls(
      src,
      { name, width, height, fit, blur, quality, gravity, metadata, background, gamma, optimized, skip },
      thumbnailUrl
    )
  );

  let video = $state<HTMLVideoElement>();
  let playing = $state(false);

  $effect(() => {
    const el = video;
    if (!el || !anim) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && entry.intersectionRatio >= threshold) {
          // play() rejects if the browser blocks autoplay (e.g. unmuted) — ignore.
          void el.play().catch(() => {});
        } else {
          el.pause();
        }
      },
      { threshold }
    );

    observer.observe(el);
    return () => observer.disconnect();
  });

  // Hover-to-play after a second, as the main app does: brushing past a grid on the way somewhere
  // else must not start a decode.
  let hoverTimer: ReturnType<typeof setTimeout> | undefined;
  const onEnter = () => {
    if (!hoverPlay) return;
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => void video?.play().catch(() => {}), 1000);
  };
  const onLeave = () => {
    clearTimeout(hoverTimer);
    video?.pause();
  };
  $effect(() => () => clearTimeout(hoverTimer));
</script>

{#if anim}
  <video
    bind:this={video}
    poster={urls.poster}
    {muted}
    loop
    playsinline
    disablepictureinpicture
    preload="metadata"
    style:--max-width={width ? `${width}px` : undefined}
    class={className}
    {...rest}
  >
    <source src={urls.webm} type="video/webm" />
    <source src={urls.mp4} type="video/mp4" />
  </video>
{:else}
  <!-- A wrapper only in this mode, so the autoplay branch above renders exactly what it always did. The
       wrapper takes the caller's class so it lays out where the video would have; the video fills it. -->
  <span class="relative inline-block {className ?? ''}" style:--max-width={width ? `${width}px` : undefined}>
    <video
      bind:this={video}
      poster={urls.poster}
      {muted}
      playsinline
      disablepictureinpicture
      preload="none"
      class="block h-full w-full [object-fit:inherit]"
      onplay={() => (playing = true)}
      onpause={() => (playing = false)}
      onended={() => (playing = false)}
      onmouseenter={onEnter}
      onmouseleave={onLeave}
      {...rest}
    >
      <source src={urls.webm} type="video/webm" />
      <source src={urls.mp4} type="video/mp4" />
    </video>
    {#if !playing}
      <IconPlayerPlayFilled
        size={28}
        class="pointer-events-none absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-white drop-shadow"
        aria-hidden="true"
      />
    {/if}
  </span>
{/if}
