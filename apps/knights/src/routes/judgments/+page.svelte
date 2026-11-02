<script lang="ts">
  import { judgmentsHref } from './href';
  import Thumbnail from './Thumbnail.svelte';
  import VerdictSeal from '$lib/VerdictSeal.svelte';
  import { count } from '$lib/format';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  const STATUS_TEXT = {
    pending: 'Awaiting the verdict',
    correct: 'Rightly judged',
    wrong: 'Not quite',
    inconclusive: 'Set aside',
    forfeited: 'Forfeited by the career reset',
  } as const;

  const FILTERS = [
    ['all', 'All'],
    ['correct', 'Correct'],
    ['wrong', 'Wrong'],
    ['pending', 'Pending'],
    ['inconclusive', 'Inconclusive'],
    ['forfeited', 'Forfeited'],
  ] as const;
</script>

<div class="page-wide">
  <header class="head">
    <div>
      <p class="eyebrow">Your record</p>
      <h1 class="page-title">Your judgments</h1>
    </div>
    <p class="summary">
      {data.status.rank} · Level {data.status.level} · Gold {count(data.status.goldEarned)} earned, {count(
        data.status.goldPending
      )} pending
    </p>
  </header>

  <nav class="filters" aria-label="Filter by status">
    {#each FILTERS as [value, label] (value)}
      <a
        href={judgmentsHref(value, 1)}
        aria-current={data.filter === value ? 'true' : undefined}
        class:active={data.filter === value}>{label}</a
      >
    {/each}
  </nav>

  <div class="list">
    {#each data.judgments as judgment (`${judgment.kind}:${judgment.itemId}:${judgment.at}`)}
      <article class="judgment">
        <Thumbnail src={judgment.src} />
        <div class="body">
          <p class="prompt">{judgment.prompt}</p>
          <p class="answer">
            Your answer: {judgment.answerLabel}{#if judgment.verdictLabel}
              <span class="dot">·</span> The verdict: {judgment.verdictLabel}{/if}
          </p>
          <p class="when">
            {#if judgment.kind === 'trial'}<span class="tag">Trial</span> · {/if}{new Date(
              judgment.at
            ).toLocaleString()}
            {#if judgment.imageHref}
              · <a href={judgment.imageHref} target="_blank" rel="noopener noreferrer"
                >Open the image on Civitai</a
              >
            {/if}
          </p>
        </div>
        <div class="state"><VerdictSeal status={judgment.status} label={STATUS_TEXT[judgment.status]} /></div>
        <p class="reward">
          <span>{judgment.xp ? `+${judgment.xp}` : 0} XP</span>
          <span class="gold" class:zero={!judgment.gold}
            >{judgment.gold ? `+${judgment.gold}` : 0} gold{judgment.status === 'pending' ? ' pending' : ''}</span
          >
        </p>
      </article>
    {:else}
      <p class="empty">
        {data.filter === 'all' ? 'You have not judged anything yet.' : 'Nothing matches this filter.'}
      </p>
    {/each}
  </div>

  <nav class="pager" aria-label="Pages">
    {#if data.page > 1}
      <a class="btn" href={judgmentsHref(data.filter, data.page - 1)}>Newer</a>
    {:else}
      <span></span>
    {/if}
    <span class="page">Page {data.page}</span>
    {#if data.hasMore}
      <a class="btn" href={judgmentsHref(data.filter, data.page + 1)}>Older</a>
    {:else}
      <span></span>
    {/if}
  </nav>
</div>

<style>
  p {
    margin: 0;
  }
  .head {
    display: flex;
    justify-content: space-between;
    align-items: flex-end;
    gap: 1rem;
    margin-bottom: 1.25rem;
  }
  .head :global(.page-title) {
    margin-bottom: 0;
  }
  .summary {
    color: var(--io-parchment-muted);
    font: 400 1rem/1.4 var(--io-font-ui);
  }
  .filters {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
    margin-bottom: 1.5rem;
  }
  .filters a {
    padding: 0.55rem 1.4rem;
    border: 1px solid var(--io-gold-muted);
    border-radius: 999px;
    color: var(--io-parchment);
    font: 500 1rem/1.2 var(--io-font-ui);
    text-decoration: none;
  }
  .filters a:hover {
    border-color: var(--io-gold);
  }
  .filters a.active {
    border-color: var(--io-gold);
    background: var(--io-gold);
    color: var(--io-bg);
  }
  .list {
    border-top: 1px solid var(--io-gold-muted);
  }
  .judgment {
    display: grid;
    grid-template-columns: 72px minmax(0, 1fr) minmax(0, 16rem) 11rem;
    align-items: center;
    gap: 1.25rem;
    padding: 1rem 0;
    border-bottom: 1px solid var(--io-gold-muted);
  }
  .prompt {
    color: var(--io-parchment);
    font-size: 1.35rem;
    line-height: 1.25;
  }
  .answer,
  .when {
    margin-top: 0.2rem;
    color: var(--io-parchment-muted);
    font: 400 0.95rem/1.4 var(--io-font-ui);
  }
  .when a {
    color: var(--io-parchment-muted);
  }
  .reward {
    display: flex;
    white-space: nowrap;
    flex-direction: column;
    align-items: flex-end;
    color: var(--io-parchment);
    font: 400 1rem/1.5 var(--io-font-ui);
  }
  .gold {
    color: var(--io-gold);
  }
  .gold.zero {
    color: var(--io-parchment-muted);
  }
  .empty {
    padding: 2rem 0;
  }
  .pager {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin: 1.5rem 0 0;
  }
  .page {
    color: var(--io-parchment-muted);
    font: 400 1rem/1.3 var(--io-font-ui);
  }

  @media (max-width: 47.99rem) {
    .head {
      flex-direction: column;
      align-items: flex-start;
      gap: 0.5rem;
    }
    .judgment {
      grid-template-columns: 72px minmax(0, 1fr) auto;
      grid-template-areas:
        'thumb body body'
        'state state reward';
      gap: 0.75rem 1rem;
    }
    .judgment > :global(:first-child) {
      grid-area: thumb;
    }
    .body {
      grid-area: body;
    }
    .state {
      grid-area: state;
    }
    .reward {
      grid-area: reward;
    }
    .prompt {
      font-size: 1.2rem;
    }
    .pager {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 1rem;
    }
    .pager .page {
      display: none;
    }
  }
</style>
