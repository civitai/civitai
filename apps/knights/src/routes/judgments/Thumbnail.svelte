<script lang="ts">
  let { src }: { src: string | null } = $props();

  let failed = $state(false);
  // A new source gets a fresh chance to load.
  $effect(() => {
    src;
    failed = false;
  });
</script>

{#if src && !failed}
  <!-- The play stage's treatment at thumbnail size: the picture is fitted whole and a blurred copy fills the bands. -->
  <div class="thumb">
    <img class="backdrop" {src} alt="" aria-hidden="true" loading="lazy" decoding="async" />
    <div class="scrim"></div>
    <img
      class="picture"
      {src}
      alt="The subject of this judgment"
      width="72"
      height="72"
      loading="lazy"
      decoding="async"
      onerror={() => (failed = true)}
    />
  </div>
{:else}
  <div class="thumb gone" role="img" aria-label="This image is not shown"></div>
{/if}

<style>
  .thumb {
    position: relative;
    flex: none;
    width: 72px;
    height: 72px;
    overflow: hidden;
    border: 1px solid var(--io-gold-muted);
    border-radius: 4px;
    background: var(--io-matte);
  }
  .backdrop {
    position: absolute;
    inset: -12px;
    width: calc(100% + 24px);
    height: calc(100% + 24px);
    object-fit: cover;
    filter: blur(12px);
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
    width: 100%;
    height: 100%;
    object-fit: contain;
  }
</style>
