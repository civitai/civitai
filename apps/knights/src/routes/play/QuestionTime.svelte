<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { fade } from 'svelte/transition';
  import { reducedMotion } from '$lib/motion';
  import { QUESTION_TIME_MS } from './question-run';

  /** Shown over the stage before a run of yes/no questions; it ends by itself, or at once on a click, tap or Space. */
  let {
    category,
    paused = false,
    onstart,
  }: {
    category: string | null;
    /** A dialog is up over the page: the countdown waits, then starts over, so the card is never missed. */
    paused?: boolean;
    onstart: () => void;
  } = $props();

  let start = $state<HTMLButtonElement>();
  let countdown = $state(0);

  onMount(() => start?.focus({ preventScroll: true }));

  $effect(() => {
    if (paused) return;
    untrack(() => (countdown += 1));
    const timer = setTimeout(onstart, QUESTION_TIME_MS);
    return () => clearTimeout(timer);
  });
</script>

<!-- The backdrop is a large click target only; the keyboard and screen readers use the Start now button. -->
<div
  class="backdrop"
  role="presentation"
  style:--question-time="{QUESTION_TIME_MS}ms"
  onclick={onstart}
  out:fade={{ duration: reducedMotion() ? 120 : 160 }}
>
  <div class="card" role="dialog" aria-labelledby="question-time-title" aria-describedby="question-time-line">
    <h2 class="title" id="question-time-title">Question time</h2>
    {#if category}<span class="chip">{category}</span>{/if}
    <p class="line" id="question-time-line">
      The next few images ask a yes or no question. Your answers help build Civitai's new moderation
      model.
    </p>
    {#key countdown}
      <span class="bar" class:paused aria-hidden="true"><span class="fill"></span></span>
    {/key}
    <span class="reduced" aria-hidden="true">Starting in {QUESTION_TIME_MS / 1000} s</span>
    <button type="button" class="start" bind:this={start} onclick={onstart}>
      Start now<kbd aria-hidden="true">Space</kbd>
    </button>
    <!-- Only Knights and up see Question time, and they can all turn questions off. The click must not start the run. -->
    <p class="hint">
      Rather rate only? Turn questions off in
      <a href="/settings" onclick={(event) => event.stopPropagation()}>Settings</a>.
    </p>
  </div>
</div>

<style>
  .backdrop {
    position: absolute;
    inset: 0;
    z-index: 5;
    display: grid;
    place-items: center;
    padding: 16px;
    border-radius: 8px;
    background: color-mix(in srgb, var(--io-matte) 70%, transparent);
    cursor: pointer;
    animation: fade-in var(--motion-base) var(--ease-out-quart) both;
  }

  .card {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
    justify-content: center;
    width: min(25rem, 100%);
    min-height: 15.5rem;
    padding: 24px;
    border: 1px solid var(--io-gold-muted);
    border-radius: 8px;
    background: var(--io-surface);
    box-shadow: 0 12px 32px rgb(0 0 0 / 0.6);
    text-align: center;
    animation: card-in var(--motion-base) var(--ease-out-quart) both;
  }

  .title {
    margin: 0;
    color: var(--io-parchment);
    font: 700 28px/1.15 var(--io-font-display);
    letter-spacing: 1.5px;
  }

  .chip {
    max-width: 100%;
    overflow: hidden;
    padding: 5px 12px;
    border: 1px solid var(--io-gold);
    border-radius: 999px;
    background: color-mix(in srgb, var(--io-gold) 14%, transparent);
    color: var(--io-gold);
    font: 600 11px/1.3 var(--io-font-ui);
    letter-spacing: 2px;
    text-overflow: ellipsis;
    text-transform: uppercase;
    white-space: nowrap;
    animation: chip-glow var(--motion-milestone-min) var(--ease-out-quart) var(--motion-base) both;
  }

  .line {
    margin: 0;
    color: var(--io-parchment-muted);
    font: 16px/1.4 var(--io-font-body);
  }

  .bar {
    position: relative;
    width: 180px;
    height: 3px;
    overflow: hidden;
    border-radius: 2px;
    background: color-mix(in srgb, var(--io-gold-muted) 45%, transparent);
  }

  .fill {
    position: absolute;
    inset: 0;
    background: var(--io-gold);
    transform-origin: left;
    animation: countdown calc(var(--question-time) - var(--motion-base)) linear var(--motion-base) both;
  }

  .bar.paused .fill {
    animation-play-state: paused;
  }

  .start {
    display: inline-flex;
    gap: 6px;
    align-items: center;
    min-height: 0;
    padding: 4px 8px;
    border: 0;
    background: none;
    color: var(--io-parchment-muted);
    font: 12px/1.3 var(--io-font-ui);
    cursor: pointer;
  }

  .start:hover:not(:disabled) {
    background: none;
    color: var(--io-parchment);
  }

  .start:focus-visible {
    outline: 2px solid var(--io-gold);
    outline-offset: 2px;
  }

  .start kbd {
    font: inherit;
  }

  .reduced {
    display: none;
  }

  .hint {
    margin: 0;
    color: var(--io-parchment-muted);
    font: 12px/1.4 var(--io-font-ui);
  }

  .hint a {
    color: var(--io-gold);
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  .hint a:hover {
    color: var(--io-parchment);
  }

  @media (hover: none) {
    .start kbd {
      display: none;
    }
  }

  @media (max-width: 40rem) {
    .card {
      width: min(18.75rem, 100%);
      min-height: 14.75rem;
      gap: 10px;
    }
    .title {
      font-size: 24px;
    }
    .line {
      font-size: 15px;
    }
    .bar {
      width: 140px;
    }
  }

  @keyframes fade-in {
    from {
      opacity: 0;
    }
  }

  @keyframes card-in {
    from {
      opacity: 0;
      transform: scale(0.96);
    }
  }

  @keyframes chip-glow {
    0%,
    100% {
      box-shadow: 0 0 0 transparent;
    }
    40% {
      box-shadow: 0 0 12px color-mix(in srgb, var(--io-gold) 55%, transparent);
    }
  }

  @keyframes countdown {
    from {
      transform: scaleX(0);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .backdrop,
    .card {
      animation: fade-in var(--motion-fast) linear both;
    }
    .chip {
      animation: none;
    }
    .bar {
      display: none;
    }
    .reduced {
      display: inline;
      color: var(--io-parchment-muted);
      font: 12px/1.3 var(--io-font-ui);
    }
  }
</style>
