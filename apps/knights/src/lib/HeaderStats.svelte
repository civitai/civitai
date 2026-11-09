<script lang="ts">
  import { untrack } from 'svelte';
  import Icon from './Icon.svelte';
  import StatPopover from './StatPopover.svelte';
  import XpGauge from './XpGauge.svelte';
  import { count, percent } from './format';
  import { nextRankRequirements, pendingSegment, xpLine } from './gauge';
  import { goldView } from './gold-view';
  import { tween } from './motion';
  import { rewardDeltas } from './rewards';
  import { sound } from './sound';
  import type { PlayerStatus } from './server/player-status';

  type Streak = { streak: number; shields: number; maxShields: number };
  type LadderRow = { rank: string; fromLevel: number; accuracyBar: number; minDaysPlayed?: number };

  let {
    status,
    streak,
    goldPerBuzz,
    shopOpen,
    ladder,
  }: {
    status: PlayerStatus;
    streak?: Streak;
    goldPerBuzz: number;
    shopOpen: boolean;
    ladder: LadderRow[];
  } = $props();

  const gold = $derived(goldView(status, goldPerBuzz));
  const segment = $derived(pendingSegment(status.xpIntoLevel, status.xpForNextLevel, status.xpPending));
  const fraction = $derived(segment.confirmed);
  const requirements = $derived(nextRankRequirements(status, ladder));
  const toNext = $derived(status.xpForNextLevel - status.xpIntoLevel);

  // What a vote just earned floats up from its chip and the gold counter ticks to its new value. The counter is spendable gold
  // (as in the shop; pending is in its title), so it moves when votes settle. Ambient only: nothing here waits on, or blocks, the next answer.
  let shownGold = $state(untrack(() => goldView(status, goldPerBuzz).pill));
  let floater = $state<{ id: number; xp: number; gold: number } | null>(null);
  let previous: PlayerStatus | null = null;
  let cancelTick: (() => void) | undefined;
  let floatTimer: ReturnType<typeof setTimeout> | undefined;
  let floatId = 0;

  $effect(() => {
    const next = status;
    const deltas = rewardDeltas(previous, next);
    previous = next;
    if (deltas.goldEarned > 0) sound.play('gold');
    cancelTick?.();
    cancelTick = tween(untrack(() => shownGold), gold.pill, 360, (value) => (shownGold = Math.round(value)));
    if (deltas.xp > 0 || deltas.gold > 0) {
      floater = { id: ++floatId, xp: deltas.xp, gold: deltas.gold };
      clearTimeout(floatTimer);
      floatTimer = setTimeout(() => (floater = null), 500);
    }
  });
  $effect(() => () => {
    cancelTick?.();
    clearTimeout(floatTimer);
  });
</script>

<ul class="stats" aria-label="Your standing">
  {#if streak}
    <li
      class="chip wide"
      title="Shields: {streak.shields}/{streak.maxShields}. A shield covers one missed day."
    >
      <span class="flame"><Icon name="flame" /></span>
      {streak.streak}
      {streak.streak === 1 ? 'day' : 'days'} streak
    </li>
  {/if}

  <li title={gold.title}>
    <StatPopover id="gold-popover" label="Gold: {gold.title}, details">
      {#snippet trigger()}
        <span class="icon"><Icon name="coins" /></span>
        {count(shownGold)}
        {#if floater && floater.gold > 0}
          {#key floater.id}<span class="floater" aria-hidden="true">+{count(floater.gold)} gold</span>{/key}
        {/if}
      {/snippet}
      <p class="head">Gold</p>
      <div class="row">
        <div class="label"><strong>Spendable</strong><span>Ready to spend</span></div>
        <b class="value"><Icon name="coins" />{gold.spendable}</b>
      </div>
      <div class="row">
        <div class="label"><strong>Pending</strong><span>Awaiting verdicts</span></div>
        <b class="value">{gold.pending}</b>
      </div>
      <hr />
      <div class="row">
        <div class="label"><strong>Worth in Buzz</strong><span>{gold.rate}</span></div>
        <b class="value"><Icon name="zap" />{gold.buzz}</b>
      </div>
      {#if shopOpen}
        <a class="convert" href="/shop">Visit the shop<Icon name="arrow-right" size={14} /></a>
      {/if}
    </StatPopover>
  </li>

  <li>
    <StatPopover id="rank-popover" label="{status.rank}, level {status.level}, details">
      {#snippet trigger()}
        <XpGauge level={status.level} {fraction} pending={segment.pending} size={30} />
        <span class="rank-name">{status.rank}</span>
        {#if floater && floater.xp > 0}
          {#key floater.id}<span class="floater" aria-hidden="true">+{count(floater.xp)} XP</span>{/key}
        {/if}
      {/snippet}
      <div class="rank-head">
        <XpGauge level={status.level} {fraction} pending={segment.pending} size={48} />
        <div class="label"><strong class="rank-title">{status.rank}</strong><span>Level {status.level}</span></div>
      </div>
      <div class="meter">
        <div class="meter-row">
          <b>{xpLine(status.xpIntoLevel, status.xpForNextLevel, status.xpPending)}</b>
          <span>{count(toNext)} to level {status.level + 1}</span>
        </div>
        <div class="track" aria-hidden="true">
          <div class="bar" style:width="{fraction * 100}%"></div>
          <div class="bar ahead" style:left="{fraction * 100}%" style:width="{segment.pending * 100}%"></div>
        </div>
      </div>
      {#if status.rating.bar !== null}
        <div class="meter">
          {#if status.rating.accuracy === null}
            <div class="meter-row">
              <b>Not yet rated</b>
              <span>{status.rating.graded}/{status.rating.minGraded} graded</span>
            </div>
          {:else}
            <div class="meter-row" class:below={status.rating.belowBar}>
              <b>Accuracy {percent(status.rating.accuracy)}</b>
              <span>{status.rank} bar {percent(status.rating.bar)}</span>
            </div>
            <div class="track" aria-hidden="true">
              <div class="bar" style:width="{status.rating.accuracy * 100}%"></div>
              <div class="mark" style:left="{status.rating.bar * 100}%"></div>
            </div>
          {/if}
        </div>
      {/if}
      {#if requirements.length > 0 && status.nextRank}
        <hr />
        <p class="head">Next rank · {status.nextRank.rank}</p>
        <ul class="needs">
          {#each requirements as need (need.key)}
            <li class:met={need.met === true}>
              <Icon name={need.met ? 'circle-check' : 'circle'} size={14} />{need.text}
            </li>
          {/each}
        </ul>
      {/if}
    </StatPopover>
  </li>
</ul>

<style>
  .stats {
    display: flex;
    align-items: center;
    gap: 16px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .chip {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    border: 1px solid var(--io-gold-muted);
    border-radius: 999px;
    background: var(--io-bg);
    color: var(--io-parchment);
    font: 600 13px/1.2 var(--io-font-ui);
    white-space: nowrap;
  }
  .chip :global(svg),
  .icon :global(svg) {
    color: var(--io-gold);
  }
  .icon {
    display: inline-flex;
  }
  .flame :global(svg) {
    color: var(--io-crimson-text);
  }
  .floater {
    --rise: -14px;
    position: absolute;
    bottom: 70%;
    left: 50%;
    translate: -50% 0;
    color: var(--io-gold);
    font: 700 12px/1 var(--io-font-ui);
    pointer-events: none;
    animation: mo-float 480ms var(--ease-out-quart) both;
  }

  .head {
    margin: 0 0 8px;
    color: var(--io-gold);
    font: 600 11px/1.2 var(--io-font-ui);
    letter-spacing: 0.2em;
    text-transform: uppercase;
  }
  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 6px 0;
  }
  .label {
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .label strong {
    color: var(--io-parchment);
    font: 600 14px/1.2 var(--io-font-ui);
  }
  .label span {
    color: var(--io-parchment-muted);
    font: 400 12px/1.3 var(--io-font-ui);
  }
  .value {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: var(--io-parchment);
    font: 700 18px/1 var(--io-font-display);
  }
  .value :global(svg) {
    color: var(--io-gold);
  }
  hr {
    height: 1px;
    margin: 8px 0;
    border: 0;
    background: var(--io-gold-muted);
  }
  .convert {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    min-height: 40px;
    margin-top: 8px;
    border: 1px solid var(--io-gold);
    border-radius: 6px;
    color: var(--io-gold);
    font: 700 13px/1 var(--io-font-ui);
    text-decoration: none;
  }
  .convert:hover {
    background: color-mix(in srgb, var(--io-gold) 12%, transparent);
  }

  .rank-name {
    font: 600 13px/1.2 var(--io-font-ui);
  }
  .rank-head {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 14px;
  }
  .rank-title {
    font: 700 16px/1.2 var(--io-font-display);
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }
  .meter {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-bottom: 12px;
  }
  .meter-row {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    gap: 12px;
    color: var(--io-parchment-muted);
    font: 400 12px/1.3 var(--io-font-ui);
  }
  .meter-row b {
    color: var(--io-parchment);
    font-weight: 600;
  }
  .meter-row.below span {
    color: var(--io-crimson-text);
  }
  .track {
    position: relative;
    height: 6px;
    border-radius: 3px;
    background: var(--io-bg);
    overflow: hidden;
  }
  .bar {
    height: 100%;
    border-radius: 3px;
    background: var(--io-gold);
    transition: width 360ms var(--ease-in-out);
  }
  .bar.ahead {
    position: absolute;
    top: 0;
    border-radius: 0 3px 3px 0;
    opacity: 0.4;
    transition:
      left 360ms var(--ease-in-out),
      width 360ms var(--ease-in-out);
  }
  .mark {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 2px;
    background: var(--io-parchment);
  }
  .needs {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .needs li {
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--io-parchment);
    font: 400 13px/1.3 var(--io-font-ui);
  }
  .needs li :global(svg) {
    flex: none;
    color: var(--io-parchment-muted);
  }
  .needs li.met :global(svg) {
    color: var(--io-verdigris);
  }

  @media (prefers-reduced-motion: reduce) {
    .bar,
    .bar.ahead {
      transition: none;
    }
  }
  @media (max-width: 40rem) {
    .stats {
      gap: 8px;
    }
    .wide {
      display: none;
    }
    /* The level pill keeps its rank (design: "12 Knight"); on the narrowest phones it truncates instead of pushing the avatar off. */
    .rank-name {
      min-width: 0;
      max-width: 7ch;
      overflow: hidden;
      font-size: 12px;
      text-overflow: ellipsis;
    }
  }
</style>
