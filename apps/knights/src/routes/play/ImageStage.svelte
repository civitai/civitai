<script lang="ts">
  import { fade } from 'svelte/transition';
  import OverlayIcon from '$lib/OverlayIcon.svelte';
  import { reducedMotion } from '$lib/motion';

  let {
    src,
    alt,
    width,
    height,
    failed = false,
    onfail,
  }: {
    src: string;
    alt: string;
    width: number | null;
    height: number | null;
    failed?: boolean;
    onfail?: () => void;
  } = $props();

  // The load event can fire before this page is interactive, so a frame that already failed is checked once on mount.
  // The picture fades in once it has loaded, so a slow image never pops in; the previous stage fades out under it.
  let loaded = $state(false);
  function watchImage(img: HTMLImageElement, fail: (() => void) | undefined) {
    if (img.complete) {
      if (img.naturalWidth === 0) fail?.();
      else loaded = true;
    }
    const onError = () => fail?.();
    const onLoad = () => (loaded = true);
    img.addEventListener('error', onError);
    img.addEventListener('load', onLoad);
    return {
      destroy: () => {
        img.removeEventListener('error', onError);
        img.removeEventListener('load', onLoad);
      },
    };
  }

  // The design's motion-crossfade (160ms); a reduced-motion player gets the 150ms cap.
  const crossfade = () => ({ duration: reducedMotion() ? 150 : 160 });

  let ratio = $derived(width && height ? width / height : null);
</script>

<!-- The stage never resizes to its picture: the picture is fitted inside it and the bands the fit leaves are filled
     by a blurred copy of the same image. -->
<div class="stage" class:failed in:fade|global={crossfade()} out:fade|global={crossfade()}>
  {#if failed}
    <div class="failure" role="alert">
      <span class="glyph"><OverlayIcon name="image-off" size={40} /></span>
      <p class="title">This image could not be loaded.</p>
      <p class="hint">Skip it to see the next one.</p>
    </div>
  {:else}
    <img class="backdrop" {src} alt="" aria-hidden="true" />
    <div class="scrim"></div>
    <img
      class="picture"
      class:fitted={ratio !== null}
      class:loaded
      style:--ar={ratio}
      {src}
      {width}
      {height}
      {alt}
      use:watchImage={onfail}
    />
  {/if}
</div>

<style>
  /* Both stages share one grid cell while the old one fades out, so nothing shifts. */
  .stage {
    position: relative;
    grid-area: 1 / 1;
    display: flex;
    flex: 1 1 0;
    align-items: center;
    justify-content: center;
    min-height: 0;
    overflow: hidden;
    border-radius: 12px;
    background: var(--io-matte);
    container-type: size;
  }
  .backdrop {
    position: absolute;
    inset: -50px;
    width: calc(100% + 100px);
    height: calc(100% + 100px);
    object-fit: cover;
    filter: blur(50px);
  }
  .scrim {
    position: absolute;
    inset: 0;
    background: var(--io-bg);
    opacity: 0.65;
  }
  .picture {
    position: relative;
    display: block;
    max-width: 100%;
    max-height: 100%;
    border: 1px solid var(--io-gold-muted);
    border-radius: 6px;
    opacity: 0;
    transition: opacity var(--motion-crossfade) var(--ease-out-quart);
  }
  .picture.loaded {
    opacity: 1;
  }
  /* A known ratio lets the picture grow to the stage, so its box (and its hairline) is exactly the picture. */
  .picture.fitted {
    width: min(100cqw, 100cqh * var(--ar));
    height: auto;
    aspect-ratio: var(--ar);
    object-fit: contain;
  }
  /* A picture that will not load leaves the stage as it was, so the answer pills stay where they are. */
  .stage.failed {
    border: 1px solid var(--io-crimson);
    background: var(--io-surface);
  }
  .failure {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    padding: 24px;
    text-align: center;
  }
  .glyph {
    display: flex;
    margin-bottom: 8px;
    color: var(--io-crimson-text);
  }
  .failure p {
    margin: 0;
  }
  .title {
    color: var(--io-crimson-text);
    font: 400 28px/1.3 var(--io-font-body);
  }
  .hint {
    color: var(--io-parchment-muted);
    font: 400 20px/1.3 var(--io-font-body);
  }
  @media (max-width: 40rem) {
    .stage {
      border-radius: 8px;
    }
    .picture {
      border-radius: 4px;
    }
    .title {
      font-size: 24px;
    }
    .hint {
      font-size: 18px;
    }
  }
</style>
