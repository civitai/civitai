<script lang="ts">
  import OverlayIcon from '$lib/OverlayIcon.svelte';

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
  function watchImage(img: HTMLImageElement, fail: (() => void) | undefined) {
    if (img.complete && img.naturalWidth === 0) fail?.();
    const handler = () => fail?.();
    img.addEventListener('error', handler);
    return { destroy: () => img.removeEventListener('error', handler) };
  }

  let ratio = $derived(width && height ? width / height : null);
</script>

<!-- The stage never resizes to its picture: the picture is fitted inside it and the bands the fit leaves are filled
     by a blurred copy of the same image. -->
<div class="stage" class:failed>
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
  .stage {
    position: relative;
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
    animation: arrive var(--motion-crossfade) var(--ease-out-quart);
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
  @keyframes arrive {
    from {
      opacity: 0;
    }
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
