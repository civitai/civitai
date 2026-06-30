<script lang="ts">
  import type { HTMLImgAttributes } from 'svelte/elements';
  import { getEdgeUrl, type EdgeUrlOptions } from '$lib/media/edge-url';

  type Props = Omit<HTMLImgAttributes, 'src' | 'width' | 'height'> &
    EdgeUrlOptions & {
      /** Cloudflare-images key — the Image row's `url`/GUID column (NOT the numeric id). */
      src: string;
      /** Fade the image in once it has loaded. */
      fadeIn?: boolean;
    };

  let {
    src,
    name,
    width,
    height,
    fit,
    anim,
    blur,
    quality,
    gravity,
    metadata,
    background,
    gamma,
    optimized,
    transcode,
    type = 'image',
    original,
    skip,
    fadeIn = false,
    alt = '',
    class: className,
    ...rest
  }: Props = $props();

  const url = $derived(
    getEdgeUrl(src, {
      name,
      width,
      height,
      fit,
      anim,
      blur,
      quality,
      gravity,
      metadata,
      background,
      gamma,
      optimized,
      transcode,
      type,
      original,
      skip,
    })
  );

  let loaded = $state(false);
</script>

<img
  src={url}
  {alt}
  width={width ?? undefined}
  height={height ?? undefined}
  loading="lazy"
  decoding="async"
  class={className}
  style:opacity={fadeIn ? (loaded ? 1 : 0) : undefined}
  style:transition={fadeIn ? 'opacity 200ms ease' : undefined}
  onload={() => (loaded = true)}
  {...rest}
/>
