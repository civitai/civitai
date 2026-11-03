<script lang="ts">
  import { enhance } from '$app/forms';
  import type { SubmitFunction } from '@sveltejs/kit';
  import type { ApprenticeData } from './apprentice';

  type Recap = Extract<ApprenticeData, { kind: 'checkpoint' }>;

  let {
    recap,
    message,
    submitting,
    submit,
    onguide,
  }: {
    recap: Recap;
    message: string | null;
    submitting: boolean;
    submit: SubmitFunction;
    onguide: () => void;
  } = $props();

  let accuracy = $derived(recap.progress.accuracy);
  let onBar = $derived(accuracy !== null && accuracy >= recap.progress.bar);
</script>

<div class="recap">
  <header class="head">
    <p class="eyebrow">Checkpoint</p>
    <h1>{recap.right} of {recap.total} correct</h1>
    {#if accuracy !== null}
      <p class="accuracy" class:good={onBar} class:low={!onBar}>
        Accuracy {Math.floor(accuracy * 100)}%&nbsp;·&nbsp;bar {Math.round(recap.progress.bar * 100)}%
      </p>
    {/if}
  </header>

  {#if recap.coach}
    <section class="coach" aria-label="Some help">
      <p>A refresher on the rating levels can help. It takes a minute and it is always here when you want it.</p>
      <button type="button" class="secondary" onclick={onguide}>Open the rating guide</button>
    </section>
  {/if}

  {#if recap.missed.length > 0}
    <h2 class="eyebrow list-title">
      {recap.missed.length === 1 ? 'The one you missed' : `The ${recap.missed.length} you missed`}
    </h2>
    <ol class="items">
      {#each recap.missed as item, index (item.key)}
        <li class="item">
          <span class="thumb">
            {#if item.src}<img src={item.src} alt="Missed image {index + 1}" loading="lazy" />{/if}
          </span>
          <div class="body">
            <p class="line">
              <span class="said">You said {item.answerLabel}</span>
              <span class="correct">Correct: {item.correctLabel}</span>
            </p>
            {#if item.explanation}<p class="explanation">{item.explanation}</p>{/if}
          </div>
        </li>
      {/each}
    </ol>
  {:else}
    <p class="clean">You got every one right. Well done.</p>
  {/if}

  {#if message}<p class="notice" role="alert">{message}</p>{/if}

  <div class="actions">
    <form method="POST" action="?/continueCheckpoint" use:enhance={submit}>
      <button type="submit" class="primary" disabled={submitting}>Continue</button>
    </form>
  </div>
</div>

<style>
  .recap {
    display: flex;
    flex-direction: column;
    gap: 16px;
    width: 100%;
    max-width: 1056px;
    margin: 0 auto;
    padding: 24px 28px 0;
  }
  .eyebrow {
    margin: 0;
    color: var(--io-gold);
    font: 600 11px/1.2 var(--io-font-ui);
    letter-spacing: 3px;
    text-transform: uppercase;
  }
  .head {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    text-align: center;
  }
  h1 {
    margin: 0;
    color: var(--io-parchment);
    font: 700 40px/1.1 var(--io-font-display);
    letter-spacing: 0.04em;
  }
  .accuracy {
    margin: 0;
    color: var(--io-parchment-muted);
    font: 600 16px/1.3 var(--io-font-ui);
  }
  .accuracy.good {
    color: #7dc4a0;
  }
  .accuracy.low {
    color: #e0a94a;
  }
  .coach {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 12px 24px;
    padding: 14px 18px;
    border: 1px solid var(--io-gold-muted);
    border-radius: 8px;
    background: var(--io-surface);
  }
  .coach p {
    flex: 1 1 18rem;
    margin: 0;
    color: var(--io-parchment);
    font: 400 17px/1.4 var(--io-font-body);
  }
  .secondary {
    padding: 10px 18px;
    border: 1px solid var(--io-gold);
    background: transparent;
    color: var(--io-gold);
    font: 700 13px/1 var(--io-font-display);
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }
  .list-title {
    letter-spacing: 4px;
  }
  .clean {
    margin: 0;
    color: var(--io-parchment-muted);
    font: 400 20px/1.4 var(--io-font-body);
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
    display: flex;
    gap: 16px;
    min-width: 0;
    padding: 12px;
    border: 1px solid var(--io-crimson);
    border-radius: 8px;
    background: var(--io-surface);
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
  .explanation {
    margin: 4px 0 0;
    color: var(--io-parchment-muted);
    font: 400 17px/1.4 var(--io-font-body);
  }
  .actions {
    display: flex;
    justify-content: center;
    padding: 8px 0 32px;
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

  @media (max-width: 56rem) {
    .items {
      grid-template-columns: minmax(0, 1fr);
    }
  }
  @media (max-width: 40rem) {
    .recap {
      gap: 12px;
      padding: 16px 16px 0;
    }
    h1 {
      font-size: 30px;
    }
    /* The one action stays in reach while the list scrolls. */
    .actions {
      position: sticky;
      bottom: 0;
      z-index: 2;
      margin: 0 -16px;
      padding: 12px 16px max(12px, env(safe-area-inset-bottom));
      border-top: 1px solid var(--io-gold-muted);
      background: var(--io-bg);
    }
    .actions :global(form),
    .primary {
      width: 100%;
    }
  }
</style>
