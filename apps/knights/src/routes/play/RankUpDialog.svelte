<script lang="ts">
  import { onMount } from 'svelte';
  import { enhance } from '$app/forms';
  import type { SubmitFunction } from '@sveltejs/kit';
  import Icon from '$lib/Icon.svelte';
  import RankBadge from '$lib/RankBadge.svelte';
  import { modal } from '$lib/modal';
  import { skippable } from '$lib/motion';
  import { rankUpChanges } from '$lib/rank-up';
  import { sound } from '$lib/sound';
  import '$lib/overlay.css';

  let {
    rank,
    level,
    levels,
    goldMultiplier,
    previous,
    badge = null,
    message,
    submitting,
    submit,
  }: {
    rank: string;
    level: number;
    levels?: string;
    goldMultiplier?: number;
    /** The rank below's perks, for the before and after. */
    previous?: { goldMultiplier: number };
    /** The rank's badge image; without one the crest shows. */
    badge?: string | null;
    message: string | null;
    submitting: boolean;
    submit: SubmitFunction;
  } = $props();

  let form = $state<HTMLFormElement>();
  const changes = $derived(
    goldMultiplier === undefined ? [] : rankUpChanges(previous, { goldMultiplier })
  );
  onMount(() => sound.play(rank === 'Knight' ? 'knighting-ring' : 'rankup'));
  const close = () => {
    if (!submitting) form?.requestSubmit();
  };
</script>

<div class="ov-backdrop">
  <div
    class="rankup"
    role="dialog"
    aria-modal="true"
    aria-labelledby="rankup-title"
    tabindex="-1"
    use:modal={{ onescape: close }}
    use:skippable
  >
    <section class="card">
      <p class="ov-eyebrow">Rank achieved</p>
      <span class="glow" aria-hidden="true"></span>
      <span class="crest"><RankBadge {rank} src={badge} size={160} /></span>
      <p class="rank">{rank}</p>
      <h2 id="rankup-title">You have risen to {rank}</h2>
      {#if levels}<p class="levels">Levels {levels}. The Order trusts your judgment more.</p>{/if}
      {#if changes.length > 0}
        <dl class="changes">
          {#each changes as change (change.key)}
            <div>
              <dt>{change.label}</dt>
              <dd>{change.from}<Icon name="arrow-right" size={12} /><b>{change.to}</b></dd>
            </div>
          {/each}
        </dl>
      {:else if goldMultiplier !== undefined}
        <p class="lead">Your gold now counts {goldMultiplier}x.</p>
      {:else}
        <p class="lead">You are now a {rank} of the Order, at level {level}.</p>
      {/if}
      {#if message}
        <p class="notice" role="alert">{message}</p>
      {/if}
      <form method="POST" action="?/dismissProgress" use:enhance={submit} bind:this={form}>
        <button type="submit" class="ov-primary" disabled={submitting} data-autofocus>Onward</button>
      </form>
    </section>
  </div>
</div>

<style>
  .rankup {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 24px;
    width: min(100%, 640px);
    max-height: 100%;
    /* Room below Onward for its focus ring, which the scroll container would otherwise clip. */
    padding-bottom: 4px;
    overflow-y: auto;
  }
  /* The design's M7 (1200ms, skippable): the banner unrolls under a gold roller, the crest rises, a shimmer crosses, and
     Onward fades in last. */
  .card {
    position: relative;
    /* `backwards`, not `both`: a clip-path left on after the unroll would clip the phone's fixed Onward. */
    animation: mo-unroll var(--motion-milestone-min) var(--ease-out-quart) backwards;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
    width: 100%;
    /* The shimmer ends parked at translateX(100%); unclipped it widens the dialog and adds a horizontal scrollbar. */
    overflow: hidden;
    padding: 36px 32px;
    border: 1px solid var(--io-gold);
    border-radius: 8px;
    background: linear-gradient(180deg, #3a2c10, var(--io-surface));
    text-align: center;
  }
  .card::before {
    content: '';
    position: absolute;
    right: 0;
    left: 0;
    height: 3px;
    background: var(--io-gold);
    box-shadow: 0 0 10px rgb(201 162 74 / 0.7);
    pointer-events: none;
    animation: mo-roller var(--motion-milestone-min) var(--ease-out-quart) both;
  }
  .card::after {
    content: '';
    position: absolute;
    inset: 0;
    background: linear-gradient(115deg, transparent 30%, rgb(232 220 192 / 0.28) 50%, transparent 70%);
    pointer-events: none;
    animation: mo-sweep 500ms var(--ease-in-out) 1000ms both;
  }
  .crest {
    position: relative;
    display: inline-flex;
    animation: mo-crest-rise 300ms var(--ease-stamp) 450ms backwards;
    margin: 8px 0 2px;
  }
  /* A soft gold glow behind the badge. */
  .glow {
    position: absolute;
    top: 44px;
    left: 50%;
    width: 260px;
    height: 260px;
    translate: -50% 0;
    border-radius: 50%;
    background: radial-gradient(circle, rgb(201 162 74 / 0.32), transparent 68%);
    pointer-events: none;
  }
  .rank {
    margin: 0;
    color: var(--io-parchment);
    font: 700 18px/1.2 var(--io-font-display);
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }
  .levels {
    margin: 0;
    color: var(--io-parchment-muted);
    font: 400 13px/1.2 var(--io-font-ui);
  }
  .changes {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 12px;
    width: 100%;
    margin: 14px 0 0;
  }
  .changes div {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    padding: 12px 8px;
    border: 1px solid var(--io-gold-muted);
    border-radius: 8px;
    background: var(--io-bg);
  }
  .changes dt {
    color: var(--io-parchment-muted);
    font: 600 11px/1.2 var(--io-font-ui);
    letter-spacing: 0.14em;
    text-transform: uppercase;
  }
  .changes dd {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 0;
    color: var(--io-parchment-muted);
    font: 600 16px/1.2 var(--io-font-ui);
  }
  .changes dd b {
    color: var(--io-gold);
    font-weight: 700;
  }
  h2 {
    margin: 14px 0 0;
    color: var(--io-parchment);
    font: 700 28px/1.15 var(--io-font-display);
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  .lead {
    margin: 8px 0 0;
    color: var(--io-parchment-muted);
    font: 400 22px/1.4 var(--io-font-body);
  }
  form {
    margin-top: 14px;
  }
  form :global(button) {
    animation: mo-fade-in var(--motion-base) var(--ease-out-quart) 1000ms backwards;
  }

  /* On a phone the card fills the width and Onward is pinned to the bottom. */
  @media (max-width: 40rem) {
    .ov-backdrop {
      padding: 16px 16px 88px;
    }
    .rankup {
      width: 100%;
    }
    .card {
      padding: 28px 20px;
    }
    h2 {
      font-size: 22px;
    }
    .lead {
      font-size: 22px;
    }
    .changes {
      grid-template-columns: minmax(0, 1fr);
      gap: 8px;
    }
    .changes div {
      flex-direction: row;
      justify-content: space-between;
      padding: 10px 14px;
    }
    form {
      margin-top: 0;
      position: fixed;
      right: 16px;
      bottom: max(16px, env(safe-area-inset-bottom));
      left: 16px;
    }
    form :global(button) {
      width: 100%;
    }
  }
</style>
