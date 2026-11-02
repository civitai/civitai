<script lang="ts">
  import RankEmblem from './RankEmblem.svelte';
  import { count, percent } from './format';

  type Rank = {
    rank: string;
    levels: string;
    accuracyBar: number;
    voteWeight?: number;
    goldMultiplier?: number;
    dailyGoldCap?: number;
  };
  let { ranks, current }: { ranks: Rank[]; current?: string } = $props();
</script>

<ol class="cards">
  <li class="card" class:mine={current === 'Acolyte'}>
    <RankEmblem rank="Acolyte" />
    <p class="name">Acolyte</p>
    <p class="levels">The Trials</p>
    <div class="facts">
      <p class="main">Everyone begins here</p>
      <p>Answers decide nothing; no XP or gold</p>
    </div>
  </li>
  {#each ranks as rank (rank.rank)}
    <li class="card" class:mine={current === rank.rank}>
      <RankEmblem rank={rank.rank} />
      <p class="name">{rank.rank}</p>
      <p class="levels">Levels {rank.levels}</p>
      <div class="facts">
        <p class="main">Levels {rank.levels} · accuracy {percent(rank.accuracyBar)}</p>
        {#if rank.voteWeight !== undefined && rank.goldMultiplier !== undefined && rank.dailyGoldCap !== undefined}
          <p>Vote {rank.voteWeight}x · gold {rank.goldMultiplier}x · {count(rank.dailyGoldCap)} a day</p>
        {/if}
      </div>
    </li>
  {/each}
</ol>

<style>
  .cards {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 1.5rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .card {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.35rem;
    text-align: center;
  }
  p {
    margin: 0;
  }
  .name {
    margin-top: 0.4rem;
    color: var(--io-parchment);
    font: 700 1.25rem/1.2 var(--io-font-display);
    letter-spacing: 0.14em;
    text-transform: uppercase;
  }
  .mine .name {
    color: var(--io-gold);
  }
  .levels {
    color: var(--io-parchment-muted);
    font: 400 0.9rem/1.3 var(--io-font-ui);
  }
  .facts {
    margin-top: 0.4rem;
    color: var(--io-parchment-muted);
    font: 400 0.85rem/1.5 var(--io-font-ui);
  }
  .facts .main {
    color: var(--io-parchment);
    font-size: 1rem;
  }
  @media (max-width: 47.99rem) {
    .cards {
      grid-template-columns: minmax(0, 1fr);
      gap: 0;
      border-bottom: 1px solid var(--io-gold-muted);
    }
    .card {
      display: grid;
      grid-template-columns: 8rem minmax(0, 1fr);
      grid-template-areas:
        'emblem facts'
        'name facts'
        'levels facts';
      justify-items: center;
      align-items: center;
      column-gap: 1rem;
      padding: 1rem 0;
      border-top: 1px solid var(--io-gold-muted);
    }
    .card > :global(.emblem) {
      grid-area: emblem;
    }
    .name {
      grid-area: name;
      margin-top: 0.2rem;
    }
    .levels {
      grid-area: levels;
    }
    .facts {
      grid-area: facts;
      justify-self: start;
      margin: 0;
      text-align: left;
    }
  }
</style>
