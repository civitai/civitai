<script lang="ts">
  import { invalidate } from '$app/navigation';
  import OverlayIcon from '$lib/OverlayIcon.svelte';
  import { count } from '$lib/format';
  import '$lib/overlay.css';

  type Daily = {
    votes: number;
    watchSize: number;
    watchDone: boolean;
    goldRecorded: number;
    goldCap: number;
    streak: number;
    shields: number;
    maxShields: number;
    bonusGold: number;
  };
  let { daily }: { daily: Daily } = $props();

  let refreshing = $state(false);
  let votes = $derived(Math.min(daily.votes, daily.watchSize));
  let left = $derived(daily.watchSize - votes);

  // Re-runs `load` for a queue that may have filled since.
  async function refresh() {
    refreshing = true;
    try {
      await invalidate('app:play');
    } finally {
      refreshing = false;
    }
  }
</script>

<div class="clear">
  <section class="message" aria-labelledby="clear-title">
    <span class="ov-crest crest"><OverlayIcon name="moon-star" size={32} /></span>
    <p class="ov-eyebrow">The queue is clear</p>
    <h1 id="clear-title">Return later</h1>
    <p class="lead">Nothing awaits your judgment right now. Return later.</p>
    <button type="button" class="ov-secondary" onclick={refresh} disabled={refreshing}>Refresh</button>
  </section>

  <section class="watch" aria-labelledby="watch-title">
    <h2 id="watch-title">Daily Watch</h2>
    <div class="bar">
      <div
        class="track"
        role="progressbar"
        aria-labelledby="watch-title"
        aria-valuemin="0"
        aria-valuemax={daily.watchSize}
        aria-valuenow={votes}
      >
        <div class="fill" style:width="{daily.watchSize > 0 ? (votes / daily.watchSize) * 100 : 0}%"></div>
      </div>
      <span class="of">{votes}/{daily.watchSize}</span>
    </div>
    {#if daily.watchDone}
      <p class="status done">
        <OverlayIcon name="circle-check" size={20} />
        Complete, +{count(daily.bonusGold)} gold streak bonus
      </p>
    {:else}
      <p class="status">{left} more {left === 1 ? 'judgment' : 'judgments'} to complete the Watch</p>
    {/if}
    <p class="line">Streak: {daily.streak} {daily.streak === 1 ? 'day' : 'days'} · Shields: {daily.shields}/{daily.maxShields}</p>
    <p class="line dim">Gold recorded today: {count(daily.goldRecorded)}/{count(daily.goldCap)}</p>
  </section>
</div>

<style>
  .clear {
    display: flex;
    flex: 1 1 auto;
    align-items: center;
    justify-content: center;
    gap: 96px;
    width: 100%;
    max-width: 1056px;
    min-height: 0;
    margin: 0 auto;
    padding: 24px 28px;
    animation: ov-fade var(--motion-base) var(--ease-out-quart);
  }
  .message {
    display: flex;
    flex: 1 1 0;
    flex-direction: column;
    align-items: flex-start;
    gap: 10px;
    min-width: 0;
  }
  .crest {
    width: 73px;
    height: 73px;
    margin-bottom: 6px;
  }
  h1 {
    margin: 0;
    color: var(--io-parchment);
    font: 700 48px/1.1 var(--io-font-display);
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .lead {
    margin: 6px 0 14px;
    color: var(--io-parchment);
    font: 400 22px/1.4 var(--io-font-body);
  }
  .watch {
    display: flex;
    flex: 0 1 420px;
    flex-direction: column;
    gap: 14px;
    min-width: 0;
    padding: 24px;
    border: 1px solid var(--io-gold-muted);
    border-radius: 8px;
    background: var(--io-surface);
  }
  h2 {
    margin: 0;
    font: 700 16px/1.2 var(--io-font-display);
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }
  .bar {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .track {
    flex: 1;
    height: 6px;
    border: 1px solid var(--io-gold-muted);
    border-radius: 3px;
    overflow: hidden;
  }
  .fill {
    height: 100%;
    background: var(--io-gold);
  }
  .of {
    color: var(--io-parchment);
    font: 600 14px/1 var(--io-font-ui);
    font-variant-numeric: tabular-nums;
  }
  .watch p {
    margin: 0;
    color: var(--io-parchment);
    font: 400 15px/1.4 var(--io-font-ui);
  }
  .status {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .status.done :global(svg) {
    color: var(--io-verdigris);
  }
  .watch .dim {
    color: var(--io-parchment-muted);
  }

  @media (max-width: 40rem) {
    .clear {
      flex-direction: column;
      justify-content: flex-start;
      gap: 20px;
      padding: 16px 16px max(16px, env(safe-area-inset-bottom));
    }
    .message {
      flex: none;
      align-items: center;
      width: 100%;
      gap: 6px;
      text-align: center;
    }
    .crest {
      width: 56px;
      height: 56px;
      margin-bottom: 2px;
    }
    h1 {
      font-size: 36px;
    }
    .lead {
      margin: 2px 0 8px;
      font-size: 20px;
    }
    .message :global(button) {
      width: 100%;
    }
    .watch {
      flex: none;
      width: 100%;
      gap: 10px;
      padding: 16px;
    }
  }
</style>
