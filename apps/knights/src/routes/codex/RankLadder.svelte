<script lang="ts">
  import RankBadge from '$lib/RankBadge.svelte';
  import { count, percent } from '$lib/format';
  import type { PlayerStatus } from '$lib/server/player-status';

  type Rank = {
    rank: string;
    levels: string;
    accuracyBar: number;
    goldMultiplier: number;
    dailyGoldCap: { from: number; to: number };
    minDaysPlayed?: number;
  };
  let {
    ranks,
    status,
    badges,
    apprenticeBarPercent,
    levelGold,
    knightLevel,
  }: {
    ranks: Rank[];
    status: PlayerStatus;
    badges: Record<string, string>;
    apprenticeBarPercent: number;
    levelGold: number;
    knightLevel: number;
  } = $props();

  const next = $derived(status.nextRank);
  const clamp = (ratio: number) => Math.min(100, Math.max(0, ratio * 100));
  const levelFill = $derived(next ? clamp(status.level / next.fromLevel) : 0);
  const accuracyFill = $derived(
    next && status.rating.accuracy !== null ? clamp(status.rating.accuracy / next.accuracyBar) : 0
  );
  const nextDays = $derived(ranks.find((rank) => rank.rank === next?.rank)?.minDaysPlayed);
  const tagOf = (rank: string) =>
    status.rank === rank ? 'You are here' : next?.rank === rank ? 'Next rank' : '';
</script>

<ol class="cards">
  <li class="card" class:mine={status.rank === 'Acolyte'}>
    <p class="tag" class:here={status.rank === 'Acolyte'}>{tagOf('Acolyte')}</p>
    <RankBadge rank="Acolyte" src={badges.Acolyte} size={104} />
    <div class="details">
      <h3>Acolyte</h3>
      <p class="levels">Everyone begins here</p>
      <dl>
        <div><dt>Accuracy bar</dt><dd>{apprenticeBarPercent}% on Trials</dd></div>
        <div><dt>Judging gold</dt><dd>None</dd></div>
        <div><dt>Level gold</dt><dd>{count(levelGold)} a level, to level {knightLevel}</dd></div>
      </dl>
    </div>
  </li>
  {#each ranks as rank (rank.rank)}
    <li class="card" class:mine={status.rank === rank.rank}>
      <p class="tag" class:here={status.rank === rank.rank}>{tagOf(rank.rank)}</p>
      <RankBadge rank={rank.rank} src={badges[rank.rank]} size={104} />
      <div class="details">
        <h3>{rank.rank}</h3>
        <p class="levels">Levels {rank.levels}</p>
        <dl>
          <div><dt>Accuracy bar</dt><dd>{percent(rank.accuracyBar)}</dd></div>
          <div><dt>Gold multiplier</dt><dd>{rank.goldMultiplier}×</dd></div>
          <div>
            <dt>Daily gold cap</dt>
            <dd>{count(rank.dailyGoldCap.from)} to {count(rank.dailyGoldCap.to)} a day</dd>
          </div>
          {#if rank.minDaysPlayed}
            <div><dt>Days played</dt><dd>{rank.minDaysPlayed}+</dd></div>
          {/if}
        </dl>
      </div>
    </li>
  {/each}
</ol>

{#if next}
  <div class="progress">
    <div class="intro">
      <h3>Your progress to {next.rank}</h3>
      <p>You are a {status.rank}, level {status.level}.</p>
    </div>
    <div class="meter">
      <p class="row"><span>Level {status.level} / {next.fromLevel}</span><span>{next.levelMet ? 'Reached' : `${next.levelsToGo} to go`}</span></p>
      <div class="bar" aria-hidden="true"><div style:width="{levelFill}%"></div></div>
    </div>
    <div class="meter">
      <p class="row">
        <span>
          {status.rating.accuracy === null
            ? `Accuracy not yet rated / ${percent(next.accuracyBar)}`
            : `Accuracy ${percent(status.rating.accuracy)} / ${percent(next.accuracyBar)}`}
        </span>
        <span>{next.accuracyMet ? 'Reached' : ''}</span>
      </p>
      <div class="bar" aria-hidden="true"><div style:width="{accuracyFill}%"></div></div>
    </div>
    {#if nextDays}
      <p class="days">
        Also at least {nextDays} days played{next.daysMet
          ? ' (reached)'
          : next.daysPlayed === undefined
            ? ''
            : ` (you have ${next.daysPlayed})`}.
      </p>
    {/if}
  </div>
{/if}

<style>
  .cards {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 16px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .card {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
    padding: 16px 16px 20px;
    border: 1px solid var(--io-gold-muted);
    border-radius: 12px;
    background: var(--io-surface);
    text-align: center;
  }
  .card.mine {
    border-color: var(--io-gold);
    box-shadow: 0 0 0 1px var(--io-gold);
  }
  .tag {
    min-height: 20px;
    margin: 0;
    padding: 2px 10px;
    border-radius: 999px;
    color: var(--io-parchment-muted);
    font: 700 10px/16px var(--io-font-ui);
    letter-spacing: 0.18em;
    text-transform: uppercase;
  }
  .tag:not(:empty) {
    border: 1px solid var(--io-gold-muted);
  }
  .tag.here {
    border-color: var(--io-gold);
    background: var(--io-gold);
    color: var(--io-bg);
  }
  .details {
    width: 100%;
  }
  h3 {
    margin: 0;
    color: var(--io-parchment);
    font: 700 18px/1.2 var(--io-font-display);
    letter-spacing: 0.14em;
    text-transform: uppercase;
  }
  .mine h3 {
    color: var(--io-gold);
  }
  .levels {
    margin: 2px 0 10px;
    color: var(--io-parchment-muted);
    font: 400 13px/1.3 var(--io-font-ui);
  }
  dl {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin: 0;
    font: 400 13px/1.3 var(--io-font-ui);
  }
  dl div {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    padding-top: 6px;
    border-top: 1px solid color-mix(in srgb, var(--io-gold-muted) 60%, transparent);
  }
  dt {
    color: var(--io-parchment-muted);
  }
  dd {
    margin: 0;
    color: var(--io-parchment);
    font-weight: 600;
    text-align: right;
  }

  .progress {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1fr);
    align-items: center;
    gap: 24px;
    margin-top: 24px;
    padding: 20px 24px;
    border: 1px solid var(--io-gold-muted);
    border-radius: 12px;
    background: var(--io-surface);
    font-family: var(--io-font-ui);
  }
  .intro h3 {
    color: var(--io-gold);
    font: 600 11px/1.2 var(--io-font-ui);
    letter-spacing: 0.2em;
  }
  .intro p {
    margin: 6px 0 0;
    color: var(--io-parchment);
    font: 400 14px/1.4 var(--io-font-ui);
  }
  .row {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    margin: 0 0 6px;
    color: var(--io-parchment-muted);
    font: 400 13px/1.3 var(--io-font-ui);
  }
  .row span:first-child {
    color: var(--io-parchment);
  }
  .bar {
    height: 6px;
    border-radius: 3px;
    background: var(--io-bg);
    overflow: hidden;
  }
  .bar div {
    height: 100%;
    border-radius: 3px;
    background: var(--io-gold);
  }
  .days {
    grid-column: 1 / -1;
    margin: 0;
    color: var(--io-parchment-muted);
    font: 400 13px/1.3 var(--io-font-ui);
  }

  @media (max-width: 64rem) {
    .cards {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
    .progress {
      grid-template-columns: minmax(0, 1fr);
      gap: 14px;
    }
  }
  /* A phone lists the ranks one under another, the badge beside its facts. */
  @media (max-width: 40rem) {
    .cards {
      grid-template-columns: minmax(0, 1fr);
    }
    .card {
      display: grid;
      grid-template-columns: 104px minmax(0, 1fr);
      grid-template-areas: 'tag tag' 'badge details';
      align-items: center;
      gap: 8px 16px;
      text-align: left;
    }
    .tag {
      grid-area: tag;
      justify-self: start;
    }
    .card > :global(.badge) {
      grid-area: badge;
    }
    .details {
      grid-area: details;
    }
  }
</style>
