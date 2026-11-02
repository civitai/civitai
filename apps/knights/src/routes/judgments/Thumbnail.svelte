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
    width="96"
    height="96"
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
    width: 96px;
    height: 96px;
    object-fit: cover;
    border: 1px solid var(--border);
    background: var(--panel);
  }
  @media (max-width: 40rem) {
    img,
    .gone {
      width: 72px;
      height: 72px;
    }
  }
</style>
