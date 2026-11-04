<script lang="ts">
  import Icon from './Icon.svelte';
  import { recapView } from './recap-view';
  import type { Recap } from './server/daily/daily.service';

  let { recap }: { recap: Recap | null } = $props();
  const view = $derived(recap ? recapView(recap) : null);
</script>

<section class="card" aria-labelledby="verdicts-title">
  <p class="eyebrow" id="verdicts-title">Yesterday's verdicts</p>
  {#if view}
    <h2>{view.headline}</h2>
    <ul class="stats">
      {#each view.stats as stat (stat.key)}
        <li class={stat.key}>
          <b>{stat.value}</b>
          <span class="label">{stat.label}</span>
          <span class="note">{stat.note}</span>
        </li>
      {/each}
    </ul>
    <div class="payout">
      <Icon name="coins" size={20} />
      <div>
        <p class="gold">{view.payout.gold}</p>
        <p class="note">{view.payout.note}</p>
      </div>
    </div>
  {:else}
    <h2>No verdicts yet</h2>
    <p class="empty">Play today's Watch and your verdicts will be waiting here tomorrow.</p>
  {/if}
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
  .stats {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px;
    margin: 0 0 16px;
    padding: 0;
    list-style: none;
  }
  .stats li {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 12px;
    border: 1px solid var(--io-gold-muted);
    border-radius: 8px;
    background: var(--io-bg);
  }
  b {
    color: var(--io-parchment);
    font: 700 1.75rem/1.1 var(--io-font-display);
  }
  .confirmed b {
    color: var(--io-verdigris);
  }
  .missed b {
    color: var(--io-crimson-text);
  }
  .undecided b {
    color: var(--io-parchment-muted);
  }
  .label {
    color: var(--io-parchment);
    font: 600 12px/1.2 var(--io-font-ui);
    letter-spacing: 0.14em;
    text-transform: uppercase;
  }
  .note {
    margin: 0;
    color: var(--io-parchment-muted);
    font: 400 12px/1.3 var(--io-font-ui);
  }
  .payout {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 14px 16px;
    border: 1px solid var(--io-gold);
    border-radius: 8px;
    background: var(--io-bg);
  }
  .payout :global(svg) {
    flex: none;
    color: var(--io-gold);
  }
  .payout p {
    margin: 0;
  }
  .gold {
    color: var(--io-gold);
    font: 700 1.15rem/1.2 var(--io-font-display);
  }
  .empty {
    margin: 0;
    color: var(--io-parchment-muted);
    font: 400 1.05rem/1.5 var(--io-font-body);
  }
</style>
