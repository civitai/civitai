<script lang="ts">
  import type { Snippet } from 'svelte';

  let {
    id,
    eyebrow,
    title,
    children,
  }: { id: string; eyebrow: string; title: string; children: Snippet } = $props();
</script>

<section class="card" aria-labelledby={id}>
  <p class="eyebrow" {id}>{eyebrow}</p>
  <h2>{title}</h2>
  {@render children()}
</section>

<style>
  .card {
    padding: 24px;
    border: 1px solid var(--io-gold-muted);
    border-radius: 12px;
    background: var(--io-surface);
  }
  .eyebrow {
    margin: 0 0 8px;
  }
  h2 {
    margin: 0 0 16px;
    color: var(--io-parchment);
    font: 700 1.25rem/1.3 var(--io-font-display);
    letter-spacing: 0.02em;
  }
  .card :global(.home-card-box) {
    border: 1px solid var(--io-gold-muted);
    border-radius: 8px;
    background: var(--io-bg);
  }
</style>
