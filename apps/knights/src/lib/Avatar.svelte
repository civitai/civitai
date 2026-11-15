<script lang="ts">
  let {
    src,
    name,
    size,
    class: className = '',
  }: { src: string | null | undefined; name: string; size?: number; class?: string } = $props();

  // Keyed on the url, so a new url gets a fresh try after an earlier one failed.
  let failedSrc = $state<string | null>(null);
  const showImage = $derived(Boolean(src) && failedSrc !== src);
</script>

<span class="avatar {className}" style:--avatar-size={size ? `${size}px` : undefined}>
  {#if showImage}
    <img {src} alt="" loading="lazy" onerror={() => (failedSrc = src ?? null)} />
  {:else}
    <span class="initial" aria-hidden="true">{(name[0] ?? 'K').toUpperCase()}</span>
  {/if}
</span>

<style>
  .avatar {
    display: inline-flex;
    flex: none;
    width: var(--avatar-size, 28px);
    height: var(--avatar-size, 28px);
  }
  img,
  .initial {
    box-sizing: border-box;
    width: 100%;
    height: 100%;
    border: var(--avatar-ring, 1px solid var(--io-gold));
    border-radius: 50%;
    background: var(--io-bg);
  }
  img {
    object-fit: cover;
  }
  .initial {
    display: grid;
    place-items: center;
    color: var(--io-gold);
    font: 700 calc(var(--avatar-size, 28px) * 0.46) / 1 var(--io-font-display);
  }
</style>
