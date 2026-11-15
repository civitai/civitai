<script lang="ts">
  import HeartsRow from '$lib/HeartsRow.svelte';
  import Icon from '$lib/Icon.svelte';
  import { belowBarCue, watchStrip, withArticle } from '$lib/chrome';
  import { count, percent } from '$lib/format';
  import { nextRankRequirements, pendingSegment } from '$lib/gauge';
  import { bump } from '$lib/motion';
  import type { DailyStatus } from '$lib/server/daily/daily.service';
  import type { PlayerStatus } from '$lib/server/player-status';
  import type { Rail } from '$lib/server/rail';

  type LadderRow = { rank: string; fromLevel: number; accuracyBar: number; minDaysPlayed?: number };
  let {
    status,
    daily,
    rail,
    ladder,
  }: { status: PlayerStatus; daily: DailyStatus; rail: Rail; ladder: LadderRow[] } = $props();

  const strip = $derived(watchStrip(daily));
  const belowBar = $derived(belowBarCue(status));
  const hearts = $derived(Math.max(0, status.maxSmites - status.smites));
  const standing = $derived(rail.standing);
  const next = $derived(status.nextRank);
  const days = $derived(nextRankRequirements(status, ladder).find((need) => need.key === 'days'));
  const clamp = (ratio: number) => Math.min(100, Math.max(0, ratio * 100));
  const levelFill = $derived(next ? clamp(status.level / next.fromLevel) : 0);
  // The rank bar counts whole levels, so the level now in progress is drawn as the pending share of that one level, after the fill.
  const inLevel = $derived(pendingSegment(status.xpIntoLevel, status.xpForNextLevel, status.xpPending));
  const levelPending = $derived(next ? clamp(inLevel.pending / next.fromLevel) : 0);
  const accuracyFill = $derived(
    next && status.rating.accuracy !== null ? clamp(status.rating.accuracy / next.accuracyBar) : 0
  );
  const ring = $derived(strip.max > 0 ? strip.value / strip.max : 0);
</script>

<aside class="rail" aria-label="Your day in the Order">
  <section aria-labelledby="rail-watch">
    <h2 id="rail-watch">Today's Watch</h2>
    <div class="watch">
      <span class="ring" role="img" aria-label="{strip.value} of {strip.max} judged" use:bump={strip.value}>
        <svg viewBox="0 0 36 36" aria-hidden="true" focusable="false">
          <circle class="track" cx="18" cy="18" r="15.5" />
          <circle
            class="fill"
            cx="18"
            cy="18"
            r="15.5"
            pathLength="100"
            stroke-dasharray="100"
            stroke-dashoffset={100 - ring * 100}
          />
        </svg>
        <span class="label"><b>{strip.value}</b><i>of {strip.max}</i></span>
      </span>
      <div>
        <p class="note">
          {#if strip.done}<span class="ok"><Icon name="circle-check" size={14} /></span>{/if}{strip.note}
        </p>
        {#if strip.sub}<p class="sub">{strip.sub}</p>{/if}
      </div>
    </div>
    <div class="pair">
      <div>
        <h3>Streak</h3>
        <p class="line">
          <span class="flame"><Icon name="flame" size={18} /></span>
          <b>{daily.streak} {daily.streak === 1 ? 'day' : 'days'}</b>
        </p>
        <p class="sub">
          {daily.shieldCoversToday ? 'Shield covers today' : daily.shields > 0 ? 'Weekly shield ready' : 'No shield held'}
        </p>
      </div>
      <div>
        <h3>Hearts</h3>
        <p class="line"><HeartsRow {hearts} maxHearts={status.maxSmites} /></p>
        <p class="sub">{hearts} of {status.maxSmites}</p>
      </div>
    </div>
  </section>

  <section aria-labelledby="rail-fervor">
    <h2 id="rail-fervor" class="with-icon"><Icon name="sparkles" size={13} />This week's fervor</h2>
    <p class="big">{count(status.fervor)}</p>
    {#if standing}
      <p class="sub">Board position #{count(standing.position)} of {count(standing.total)}</p>
      <ol class="board">
        {#if standing.above}
          <li><span>#{standing.above.position}</span><span class="who">{standing.above.username}</span><b>{count(standing.above.fervor)}</b></li>
        {/if}
        <li class="me"><span>#{standing.position}</span><span class="who">You</span><b>{count(standing.fervor)}</b></li>
        {#if standing.below}
          <li><span>#{standing.below.position}</span><span class="who">{standing.below.username}</span><b>{count(standing.below.fervor)}</b></li>
        {/if}
      </ol>
      <p class="gap">
        {#if standing.above}
          <Icon name="arrow-up" size={14} />
          {standing.gap === 0
            ? `Tied with #${standing.above.position}`
            : `${count(standing.gap ?? 0)} to overtake #${standing.above.position}`}
        {:else}
          <Icon name="trophy" size={14} />You hold first place
        {/if}
      </p>
    {:else}
      <p class="sub">Not on the board yet. It tallies each day.</p>
    {/if}
  </section>

  <section aria-labelledby="rail-next">
    <h2 id="rail-next">{next ? `Next rank · ${next.rank}` : 'Rank'}</h2>
    {#if belowBar}
      <p class="below" role="status">{belowBar} <a href="/codex#ranks">Why?</a></p>
    {/if}
    {#if next}
      <div class="meter">
        <p class="row"><span>Level {status.level} / {next.fromLevel}</span><span>{next.levelMet ? 'Reached' : `${next.levelsToGo} to go`}</span></p>
        <div class="bar" aria-hidden="true">
          <div style:width="{levelFill}%"></div>
          <div class="ahead" style:left="{levelFill}%" style:width="{levelPending}%"></div>
        </div>
        {#if status.xpPending > 0}<p class="sub">+{count(status.xpPending)} XP pending</p>{/if}
      </div>
      <div class="meter">
        <p class="row">
          <span>
            {status.rating.accuracy === null
              ? `Accuracy not yet rated / ${percent(next.accuracyBar)}`
              : `Accuracy ${percent(status.rating.accuracy)} / ${percent(next.accuracyBar)}`}
          </span>
          {#if next.accuracyMet}<span class="ok"><Icon name="circle-check" size={14} /></span>{/if}
        </p>
        <div class="bar" aria-hidden="true"><div style:width="{accuracyFill}%"></div></div>
      </div>
      {#if days}<p class="sub">{days.text}</p>{/if}
    {:else}
      <p class="sub">{status.rank === 'Paladin' ? 'You hold the highest rank.' : `You are ${withArticle(status.rank)}.`}</p>
    {/if}
  </section>

  {#if rail.activity !== null}
    <section aria-labelledby="rail-activity">
      <h2 id="rail-activity">Order activity</h2>
      <p class="ticker"><span class="dot" aria-hidden="true"></span>{count(rail.activity)} {rail.activity === 1 ? 'judgment' : 'judgments'} today</p>
    </section>
  {/if}
</aside>

<style>
  .rail {
    display: none;
    flex: none;
    flex-direction: column;
    width: 296px;
    gap: 0;
    margin: 12px 24px 20px 0;
    padding: 4px 20px;
    overflow-y: auto;
    border: 1px solid var(--io-gold-muted);
    border-radius: 12px;
    background: var(--io-surface);
    font-family: var(--io-font-ui);
  }
  @media (min-width: 75rem) {
    .rail {
      display: flex;
    }
  }
  section {
    padding: 16px 0;
  }
  section + section {
    border-top: 1px solid var(--io-gold-muted);
  }
  h2 {
    margin: 0 0 12px;
    color: var(--io-gold);
    font: 600 11px/1.2 var(--io-font-ui);
    letter-spacing: 0.2em;
    text-transform: uppercase;
  }
  h2.with-icon {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  h3 {
    margin: 0 0 6px;
    color: var(--io-parchment-muted);
    font: 600 10px/1.2 var(--io-font-ui);
    letter-spacing: 0.18em;
    text-transform: uppercase;
  }
  p {
    margin: 0;
  }
  b {
    color: var(--io-parchment);
    font-weight: 600;
  }
  .below {
    margin-bottom: 12px;
    color: var(--io-crimson-text);
    font: 500 12px/1.4 var(--io-font-ui);
  }
  .below a {
    color: inherit;
    text-decoration: underline;
  }
  .sub {
    margin-top: 2px;
    color: var(--io-parchment-muted);
    font: 400 12px/1.35 var(--io-font-ui);
  }

  .watch {
    display: flex;
    align-items: center;
    gap: 16px;
    margin-bottom: 16px;
  }
  .ring {
    position: relative;
    display: grid;
    flex: none;
    place-items: center;
    width: 84px;
    height: 84px;
  }
  .ring svg {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    transform: rotate(-90deg);
  }
  .ring circle {
    fill: none;
    stroke-width: 2.6;
  }
  .ring .track {
    stroke: var(--io-bg);
  }
  .ring .fill {
    stroke: var(--io-gold);
    transition: stroke-dashoffset 360ms var(--ease-in-out);
  }
  .label {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
  }
  .label b {
    font: 700 24px/1 var(--io-font-display);
  }
  .label i {
    color: var(--io-parchment-muted);
    font: 400 11px/1.3 var(--io-font-ui);
    font-style: normal;
  }
  .note {
    color: var(--io-parchment-muted);
    font: 400 13px/1.4 var(--io-font-ui);
  }
  .note .ok {
    margin-right: 4px;
    vertical-align: -2px;
  }
  .pair {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 16px;
  }
  .line {
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--io-parchment);
    font: 600 15px/1.2 var(--io-font-ui);
  }
  .flame {
    display: inline-flex;
    color: var(--io-crimson-text);
  }

  .big {
    color: var(--io-parchment);
    font: 700 36px/1.1 var(--io-font-display);
  }
  .board {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin: 10px 0 8px;
    padding: 0;
    list-style: none;
  }
  .board li {
    display: grid;
    grid-template-columns: 2.4rem minmax(0, 1fr) auto;
    align-items: center;
    gap: 6px;
    padding: 5px 8px;
    border-radius: 6px;
    color: var(--io-parchment-muted);
    font: 400 12px/1.2 var(--io-font-ui);
  }
  .board .who {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .board .me {
    background: var(--io-bg);
    color: var(--io-gold);
  }
  .board .me b {
    color: var(--io-gold);
  }
  .gap {
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--io-gold);
    font: 600 12px/1.3 var(--io-font-ui);
  }

  .meter {
    margin-bottom: 12px;
  }
  .row {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 6px;
    color: var(--io-parchment-muted);
    font: 400 12px/1.3 var(--io-font-ui);
  }
  .row span:first-child {
    color: var(--io-parchment);
  }
  .ok {
    display: inline-flex;
    color: var(--io-verdigris);
  }
  .bar {
    position: relative;
    height: 6px;
    border-radius: 3px;
    background: var(--io-bg);
    overflow: hidden;
  }
  .bar div {
    height: 100%;
    border-radius: 3px;
    background: var(--io-gold);
    transition: width 360ms var(--ease-in-out);
  }
  .bar .ahead {
    position: absolute;
    top: 0;
    border-radius: 0 3px 3px 0;
    opacity: 0.4;
    transition:
      left 360ms var(--ease-in-out),
      width 360ms var(--ease-in-out);
  }

  .ticker {
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--io-parchment);
    font: 400 13px/1.3 var(--io-font-ui);
  }
  .dot {
    flex: none;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--io-verdigris);
    animation: pulse 2s var(--ease-in-out) infinite;
  }
  @keyframes pulse {
    50% {
      opacity: 0.35;
    }
  }
  @media (prefers-reduced-motion: no-preference) {
    .ring:global([data-bump]) .fill {
      animation: mo-bump-glow 400ms var(--ease-out-quart);
    }
    .ring:global([data-bump]) .label b {
      display: inline-block;
      animation: mo-bump-pop 400ms var(--ease-out-quart);
    }
    .ring:global([data-bump])::after {
      --rise: -10px;
      content: '+1';
      position: absolute;
      top: 6px;
      right: 8px;
      color: var(--io-gold);
      font: 700 12px/1 var(--io-font-ui);
      pointer-events: none;
      animation: mo-float 400ms var(--ease-out-quart) both;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .ring .fill,
    .bar div {
      transition-duration: 150ms;
    }
    .dot {
      animation: none;
    }
  }
</style>
