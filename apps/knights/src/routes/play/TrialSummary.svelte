<script lang="ts">
  import { onMount } from 'svelte';
  import { enhance } from '$app/forms';
  import type { SubmitFunction } from '@sveltejs/kit';
  import Countdown from '$lib/Countdown.svelte';
  import Icon from '$lib/Icon.svelte';
  import { percent } from '$lib/format';
  import { skippable } from '$lib/motion';
  import { sound } from '$lib/sound';
  import type { SummaryView } from './summary';

  let {
    summary,
    message,
    submitting,
    submit,
  }: {
    summary: SummaryView;
    message: string | null;
    submitting: boolean;
    submit: SubmitFunction;
  } = $props();

  let passed = $derived(summary.result === 'passed');
  onMount(() => {
    if (passed) sound.play('knighting-ring');
  });
</script>

{#snippet enterOrder()}
  <form method="POST" action="?/enterOrder" use:enhance={submit}>
    <button type="submit" class="primary" disabled={submitting}>Enter the Order</button>
  </form>
{/snippet}

<div class="summary" class:passed>
  {#if passed}
    <header class="banner">
      <p class="eyebrow">You have passed the Trials</p>
      <section class="knighting" aria-label="Rank achieved" use:skippable>
        <p class="eyebrow">Rank achieved</p>
        <span class="medal"><Icon name="swords" size={36} /></span>
        <p class="rank">Knight</p>
        <h1>Arise, Sir Knight</h1>
        <p class="lead">You are now a Knight of New Order. Continue to begin judging.</p>
      </section>
      <p class="score">{summary.right} of {summary.scored} correct · {percent(summary.passMark)} needed</p>
      <div class="enter-desktop">{@render enterOrder()}</div>
    </header>
  {:else}
    <header class="verdict-row">
      <div class="verdict">
        <span class="seal" aria-hidden="true"><Icon name="x" size={28} /></span>
        <div>
          <p class="eyebrow">The Trials are ended</p>
          <h1>Not yet</h1>
          <p class="score">{summary.right} of {summary.scored} correct · {percent(summary.passMark)} needed</p>
        </div>
      </div>
      {#if summary.secondsLeft !== null}
        <section class="cooldown" aria-label="Return in">
          <p class="eyebrow">Return in</p>
          <Countdown seconds={summary.secondsLeft} label="Time until you may try again" clock />
          <p class="units">hours · minutes · seconds</p>
        </section>
      {/if}
    </header>
  {/if}

  <h2 class="eyebrow list-title">Your {summary.items.length} judgments</h2>
  <ol class="items">
    {#each summary.items as item, index (item.referenceId)}
      <li class="item" class:missed={!item.correct}>
        <span class="thumb">
          {#if item.src}
            <img src={item.src} alt="Judgment {index + 1}" loading="lazy" />
          {/if}
        </span>
        <div class="body">
          <p class="eyebrow">Judgment {index + 1}{#if !item.scored}<span class="practice">&nbsp;·&nbsp;Practice, not scored</span>{/if}</p>
          <p class="line">
            <span class="said">You said {item.answerLabel}</span>
            <span class="correct">Correct: {item.correctLabel}</span>
          </p>
          {#if !item.correct && item.explanation}
            <p class="explanation">{item.explanation}</p>
          {/if}
        </div>
        <span class="mark" class:wrong={!item.correct} role="img" aria-label={item.correct ? 'Right' : 'Wrong'}>
          <Icon name={item.correct ? 'check' : 'x'} size={14} />
        </span>
      </li>
    {/each}
  </ol>

  {#if message}
    <p class="notice" role="alert">{message}</p>
  {/if}

  <div class="actions" class:passed>
    {#if passed}
      {@render enterOrder()}
    {:else}
      <button type="button" class="primary" disabled title="Available when the countdown ends">Try again</button>
      <a class="secondary desk" href="/rules">Read the rules</a>
    {/if}
  </div>
  {#if !passed}
    <a class="secondary mob" href="/rules">Read the rules</a>
  {/if}
</div>

<style>
  .summary {
    display: flex;
    flex-direction: column;
    gap: 16px;
    width: 100%;
    max-width: 1056px;
    margin: 0 auto;
    padding: 32px 28px 0;
  }
  .eyebrow {
    margin: 0;
    color: var(--io-gold);
    font: 600 11px/1.2 var(--io-font-ui);
    letter-spacing: 3px;
    text-transform: uppercase;
  }
  h1 {
    margin: 0;
    color: var(--io-parchment);
    font: 700 48px/1.1 var(--io-font-display);
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .score {
    margin: 0;
    color: var(--io-parchment-muted);
    font: 400 22px/1.3 var(--io-font-body);
  }

  .verdict-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 24px;
  }
  .verdict {
    display: flex;
    align-items: center;
    gap: 24px;
  }
  .seal {
    animation: mo-stamp var(--motion-milestone-min) var(--ease-out-quart) both;
    display: grid;
    flex: none;
    place-items: center;
    width: 68px;
    height: 68px;
    border: 3px double var(--io-parchment);
    border-radius: 50%;
    background: var(--io-crimson);
    color: var(--io-parchment);
  }
  .cooldown {
    min-width: min(100%, 320px);
    padding: 20px 24px 16px;
    border: 1px solid var(--io-gold-muted);
    border-radius: 8px;
    text-align: center;
  }
  .units {
    margin: 0;
    color: var(--io-parchment-muted);
    font: 400 13px/1.2 var(--io-font-ui);
  }

  .banner {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 20px;
    text-align: center;
  }
  /* The design's M8 (1200ms, skippable): the crest descends onto the banner, a flare marks the knighting, then the line lands. */
  .knighting {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
    width: min(100%, 560px);
    padding: 28px 24px;
    border: 1px solid var(--io-gold);
    border-radius: 8px;
    background: linear-gradient(180deg, #3a2c10, var(--io-surface));
  }
  .knighting::after {
    content: '';
    position: absolute;
    top: 96px;
    left: 50%;
    width: 300px;
    height: 300px;
    margin: -150px 0 0 -150px;
    background: radial-gradient(circle, rgb(232 220 192 / 0.9), rgb(201 162 74 / 0.4) 40%, transparent 70%);
    pointer-events: none;
    animation: mo-flare var(--motion-milestone-min) var(--ease-out-quart) var(--motion-milestone-min) both;
  }
  .knighting h1,
  .knighting .lead {
    animation: mo-rise-in var(--motion-milestone-min) var(--ease-out-quart) var(--motion-milestone-min) both;
  }
  .medal {
    animation: mo-descend var(--motion-milestone-min) var(--ease-out-quart) both;
    display: grid;
    place-items: center;
    width: 64px;
    height: 64px;
    border: 1px solid var(--io-gold);
    border-radius: 50%;
    background: var(--io-bg);
    color: var(--io-gold);
  }
  .rank {
    margin: 0;
    color: var(--io-parchment);
    font: 700 18px/1.2 var(--io-font-display);
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }
  .lead {
    margin: 0;
    color: var(--io-parchment-muted);
    font: 400 20px/1.4 var(--io-font-body);
  }

  .list-title {
    margin-top: 8px;
    letter-spacing: 4px;
  }
  .passed .list-title {
    text-align: center;
  }
  .items {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    align-items: start;
    gap: 12px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .item {
    position: relative;
    display: flex;
    gap: 16px;
    min-width: 0;
    padding: 12px;
    border: 1px solid var(--io-gold-muted);
    border-radius: 8px;
    background: var(--io-surface);
  }
  .item.missed {
    border-color: var(--io-crimson);
  }
  .thumb {
    display: grid;
    flex: none;
    place-items: center;
    width: 56px;
    height: 56px;
    border-radius: 4px;
    background: var(--io-matte);
    overflow: hidden;
  }
  .thumb img {
    width: 100%;
    height: 100%;
    object-fit: contain;
  }
  .body {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
    padding-right: 32px;
  }
  .line {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 16px;
    margin: 0;
    font: 400 15px/1.3 var(--io-font-ui);
  }
  .said {
    color: var(--io-parchment);
    font-weight: 600;
  }
  .correct {
    color: var(--io-parchment-muted);
  }
  .practice {
    color: var(--io-parchment-muted);
    letter-spacing: 1.5px;
  }
  .explanation {
    margin: 4px 0 0;
    color: var(--io-parchment-muted);
    font: 400 17px/1.4 var(--io-font-body);
  }
  .mark {
    position: absolute;
    top: 12px;
    right: 12px;
    display: grid;
    place-items: center;
    width: 24px;
    height: 24px;
    border: 1px solid var(--io-parchment);
    border-radius: 50%;
    background: var(--io-verdigris);
    color: var(--io-parchment);
  }
  .mark.wrong {
    background: var(--io-crimson);
  }

  .actions {
    display: flex;
    gap: 16px;
    padding: 16px 0 32px;
  }
  .actions.passed {
    display: none;
  }
  .enter-desktop {
    display: block;
  }
  .secondary.mob {
    display: none;
  }
  .primary {
    padding: 14px 28px;
    border-color: var(--io-gold);
    background: var(--io-gold);
    color: var(--io-bg);
    font: 700 15px/1 var(--io-font-display);
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }
  .primary:hover:not(:disabled) {
    background: var(--io-parchment);
  }
  .primary:disabled {
    border-color: var(--io-surface);
    background: #2c2515;
    color: var(--io-parchment-muted);
    opacity: 1;
    cursor: not-allowed;
  }
  .secondary {
    display: inline-flex;
    align-items: center;
    padding: 14px 28px;
    border: 1px solid var(--io-gold);
    border-radius: 6px;
    color: var(--io-gold);
    font: 700 15px/1 var(--io-font-display);
    letter-spacing: 0.12em;
    text-decoration: none;
    text-transform: uppercase;
  }

  @media (max-width: 56rem) {
    .items {
      grid-template-columns: minmax(0, 1fr);
    }
  }
  @media (max-width: 40rem) {
    .summary {
      gap: 12px;
      padding: 16px 16px 0;
    }
    h1 {
      font-size: 36px;
    }
    .score {
      font-size: 18px;
    }
    .verdict {
      gap: 16px;
    }
    .cooldown {
      width: 100%;
    }
    .lead {
      font-size: 18px;
    }
    .enter-desktop {
      display: none;
    }
    /* The one action stays in reach while the list scrolls. */
    .actions,
    .actions.passed {
      display: flex;
      position: sticky;
      bottom: 0;
      z-index: 2;
      flex-direction: column;
      gap: 8px;
      margin: 0 -16px;
      padding: 12px 16px max(12px, env(safe-area-inset-bottom));
      background: var(--io-bg);
      border-top: 1px solid var(--io-gold-muted);
    }
    .actions .primary {
      justify-content: center;
      width: 100%;
    }
    .secondary.desk {
      display: none;
    }
    .secondary.mob {
      display: flex;
      justify-content: center;
      margin-bottom: 16px;
    }
    .actions :global(form) {
      display: contents;
    }
  }
</style>
