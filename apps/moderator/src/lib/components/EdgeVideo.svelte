<script lang="ts">
  import type { HTMLVideoAttributes } from 'svelte/elements';
  import { getVideoUrls, type EdgeUrlOptions } from '$lib/media/edge-url';

  type Props = Omit<HTMLVideoAttributes, 'src' | 'poster' | 'width' | 'height'> &
    EdgeUrlOptions & {
      /** Cloudflare-images key — the Image row's `url`/GUID column (NOT the numeric id). */
      src: string;
      /** Optional still-frame key/url for the poster; defaults to a frame of `src`. */
      thumbnailUrl?: string | null;
      /**
       * Fraction of the video that must be visible before it auto-plays (and below which it
       * pauses). Defaults to 0.5 — play only when at least half the video is in the viewport.
       */
      threshold?: number;
      /** Muted is required for reliable autoplay; override only if you also surface controls. */
      muted?: boolean;
    };

  let {
    src,
    thumbnailUrl,
    threshold = 0.5,
    muted = true,
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
    // anim/transcode/type/original are fixed by getVideoUrls — absorb them so they don't leak
    // onto the <video> DOM element via ...rest.
    anim: _anim,
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

  $effect(() => {
    const el = video;
    if (!el) return;

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
</script>

<!-- svelte-ignore a11y_media_has_caption -->
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
