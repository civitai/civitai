<script lang="ts">
  import RankEmblem from './RankEmblem.svelte';

  let { rank, src = null, size }: { rank: string; src?: string | null; size: number } = $props();

  // Keyed on the address, so a new one gets a fresh try after an earlier one failed. A rank with no badge image, or an
  // image that will not load, shows the crest.
  let failedSrc = $state<string | null>(null);
  const showImage = $derived(Boolean(src) && failedSrc !== src);
</script>

<span class="badge" style:--badge-size="{size}px" role="img" aria-label="{rank} badge">
  {#if showImage}
    <img {src} alt="" onerror={() => (failedSrc = src ?? null)} />
  {:else}
    <RankEmblem {rank} fill />
  {/if}
</span>

<style>
  .badge {
    display: inline-flex;
    flex: none;
    width: var(--badge-size);
    height: var(--badge-size);
    overflow: hidden;
    border-radius: 50%;
    background: #000;
  }
  img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
</style>
