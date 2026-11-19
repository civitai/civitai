<script lang="ts">
  import Icon from './Icon.svelte';
  import { heartBackLine, heartsLeft, smiteHeading } from './chrome';

  let {
    smites,
    maxSmites,
    heartBack = null,
  }: { smites: number; maxSmites: number; heartBack?: { done: number; needed: number } | null } =
    $props();
  const hearts = $derived(heartsLeft({ smites, maxSmites }));
  const back = $derived(heartBackLine(heartBack));
</script>

<section class="smitten" aria-labelledby="smitten-title">
  <div class="top">
    <p class="eyebrow crimson">Smitten</p>
    <div class="hearts" role="img" aria-label="{hearts} of {maxSmites} hearts left">
      {#each { length: maxSmites } as _, heart (heart)}
        <span class:lost={heart >= hearts}><Icon name="heart" size={22} /></span>
      {/each}
    </div>
  </div>
  <h2 id="smitten-title">{smiteHeading(smites)}</h2>
  <p class="count">{hearts} of {maxSmites} hearts left{#if back}{' · '}{back}{/if}</p>
  <details class="explain">
    <summary>How smites work</summary>
    <p>
      Now and then you'll judge an image that already has a known rating, so we can check your calls
      still match the community's standards. Missing those earns smites. Each smite costs a heart, and
      right judgments win hearts back. Lose all {maxSmites} hearts and your career resets.
    </p>
  </details>
</section>

<style>
  .smitten {
    margin: 0;
    padding: 1rem 1.25rem;
    border: 1px solid var(--io-crimson);
    border-radius: 6px;
    background: color-mix(in srgb, var(--io-crimson) 10%, var(--io-surface));
  }
  .top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
  }
  .top .eyebrow {
    margin: 0;
  }
  h2 {
    margin: 0.5rem 0 0;
    color: var(--io-parchment);
    font-size: 1.2rem;
    text-transform: uppercase;
  }
  .hearts {
    display: flex;
    gap: 0.35rem;
    color: var(--io-crimson-text);
  }
  .hearts .lost {
    color: var(--io-parchment-muted);
    opacity: 0.55;
  }
  .count {
    margin: 0.35rem 0 0;
    font-family: var(--io-font-ui);
    font-size: 0.9rem;
  }
  .explain {
    margin-top: 0.6rem;
    color: var(--io-parchment-muted);
  }
  .explain summary {
    width: fit-content;
    color: var(--io-crimson-text);
    font: 600 0.85rem/1.4 var(--io-font-ui);
    cursor: pointer;
  }
  .explain p {
    margin: 0.5rem 0 0;
    font-size: 1rem;
    line-height: 1.5;
  }
</style>
