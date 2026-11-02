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
  <img
    {src}
    alt="The subject of this judgment"
    width="72"
    height="72"
    loading="lazy"
    decoding="async"
    onerror={() => (failed = true)}
  />
{:else}
  <div class="gone" role="img" aria-label="This image is not shown"></div>
{/if}

<style>
  img,
  .gone {
    flex: none;
    width: 72px;
    height: 72px;
    object-fit: contain;
    border: 1px solid var(--io-gold-muted);
    border-radius: 4px;
    background: var(--io-matte);
  }
</style>
