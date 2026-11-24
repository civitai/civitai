<script lang="ts">
  import { onMount } from 'svelte';
  import { QUESTION_TIME_MS } from './question-run';

  /** Shown over the stage before a run of yes/no questions; it ends by itself, or at once on a click, tap or Space. */
  let { category, onstart }: { category: string | null; onstart: () => void } = $props();

  onMount(() => {
    const timer = setTimeout(onstart, QUESTION_TIME_MS);
    return () => clearTimeout(timer);
  });
</script>

<button
  type="button"
  class="backdrop"
  style:--question-time="{QUESTION_TIME_MS}ms"
  aria-describedby="question-time-line"
  onclick={onstart}
>
  <span class="card" role="status">
    <span class="title">Question time</span>
    {#if category}<span class="chip">{category}</span>{/if}
    <span class="line" id="question-time-line">
      The next few images ask a yes or no question. Your answers help build Civitai's new moderation
      model.
    </span>
    <span class="bar" aria-hidden="true"><span class="fill"></span></span>
    <span class="reduced" aria-hidden="true">Starting in 3 s</span>
    <span class="start"><span class="desktop">Start now · Space</span><span class="touch">Tap to start</span></span>
  </span>
</button>

<style>
  .backdrop {
    position: absolute;
    inset: 0;
    z-index: 5;
    display: grid;
    place-items: center;
    padding: 16px;
    border: 0;
    border-radius: 8px;
    background: rgb(14 12 9 / 0.7);
    color: inherit;
    font: inherit;
    cursor: pointer;
    animation: fade-in var(--motion-base) var(--ease-out-quart) both;
  }

  .card {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
    width: min(25rem, 100%);
    padding: 24px;
    border: 1px solid var(--io-gold-muted);
    border-radius: 8px;
    background: var(--io-surface);
    box-shadow: 0 12px 32px rgb(0 0 0 / 0.6);
    text-align: center;
    animation: card-in var(--motion-base) var(--ease-out-quart) both;
  }

  .title {
    color: var(--io-parchment);
    font: 700 28px/1.15 var(--io-font-display);
    letter-spacing: 1.5px;
  }

  .chip {
    padding: 5px 12px;
    border: 1px solid var(--io-gold);
    border-radius: 999px;
    background: color-mix(in srgb, var(--io-gold) 14%, transparent);
    color: var(--io-gold);
    font: 600 11px/1.3 var(--io-font-ui);
    letter-spacing: 2px;
    text-transform: uppercase;
    animation: chip-glow var(--motion-milestone-min) var(--ease-out-quart) var(--motion-base) both;
  }

  .line {
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

  .start {
    color: var(--io-parchment-muted);
    font: 12px/1.3 var(--io-font-ui);
  }

  .reduced,
  .touch {
    display: none;
  }

  @media (hover: none) {
    .desktop {
      display: none;
    }
    .touch {
      display: inline;
    }
  }

  @media (max-width: 40rem) {
    .card {
      width: min(18.75rem, 100%);
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
