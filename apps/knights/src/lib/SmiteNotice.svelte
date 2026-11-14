<script lang="ts">
  import Icon from './Icon.svelte';
  import { heartsLeft, smiteHeading } from './chrome';

  let { smites, maxSmites }: { smites: number; maxSmites: number } = $props();
  const hearts = $derived(heartsLeft({ smites, maxSmites }));
</script>

<section class="smitten" aria-labelledby="smitten-title">
  <p class="eyebrow crimson">Smitten</p>
  <h2 id="smitten-title">{smiteHeading(smites)}</h2>
  <div
    class="hearts"
    role="img"
    aria-label="{hearts} of {maxSmites} hearts left"
  >
    {#each { length: maxSmites } as _, heart (heart)}
      <span class:lost={heart >= hearts}><Icon name="heart" size={32} /></span>
    {/each}
  </div>
  <p class="count">{hearts} of {maxSmites} hearts left</p>
  <p class="explain">
    Judging in bad faith earns smites. Each smite costs a heart, and right judgments win hearts
    back. Lose all {maxSmites} hearts and your career resets.
  </p>
</section>

<style>
  .smitten {
    margin: 0 0 1.5rem;
    padding: 1.25rem 1.5rem;
    border: 1px solid var(--io-crimson);
    border-radius: 6px;
    background: color-mix(in srgb, var(--io-crimson) 10%, var(--io-surface));
  }
  h2 {
    margin: 0 0 0.75rem;
    color: var(--io-parchment);
    font-size: 1.5rem;
    text-transform: uppercase;
  }
  .hearts {
    display: flex;
    gap: 0.5rem;
    color: var(--io-crimson-text);
  }
  .hearts .lost {
    color: var(--io-parchment-muted);
    opacity: 0.55;
  }
  .count {
    margin: 0.5rem 0 0.75rem;
    font-family: var(--io-font-ui);
    font-size: 0.95rem;
  }
  .explain {
    margin: 0;
    color: var(--io-parchment-muted);
    font-size: 1.1rem;
    line-height: 1.5;
  }
</style>
