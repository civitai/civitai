<script lang="ts">
  import { judgmentsHref } from './href';
  import Thumbnail from './Thumbnail.svelte';
  import StatusBar from '$lib/StatusBar.svelte';
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
    ['wrong', 'Failed'],
    ['pending', 'Pending'],
    ['inconclusive', 'Inconclusive'],
    ['forfeited', 'Forfeited'],
  ] as const;

</script>

<h1>Your judgments</h1>

<StatusBar status={data.status} />

<nav class="filters" aria-label="Filter by status">
  {#each FILTERS as [value, label] (value)}
    <a
      href={judgmentsHref(value, 1)}
      aria-current={data.filter === value ? 'true' : undefined}
      class:active={data.filter === value}>{label}</a
    >
  {/each}
</nav>

{#each data.judgments as judgment (`${judgment.kind}:${judgment.itemId}:${judgment.at}`)}
  <article class="judgment">
    <Thumbnail src={judgment.src} />
    <div>
      <p class="muted">{judgment.prompt}</p>
      <p>Your answer: {judgment.answerLabel}</p>
      {#if judgment.verdictLabel}
        <p>The verdict: {judgment.verdictLabel}</p>
      {/if}
      <p class="muted">
        {#if judgment.kind === 'trial'}<span class="tag">Trial</span> · {/if}<span
          class="state {judgment.status}">{STATUS_TEXT[judgment.status]}</span
        >
        · {judgment.xp} XP · {judgment.gold} gold{judgment.status === 'pending' ? ' pending' : ''} · {new Date(judgment.at).toLocaleString()}
      </p>
      {#if judgment.imageHref}
        <p><a href={judgment.imageHref} target="_blank" rel="noopener noreferrer">Open the image on Civitai</a></p>
      {/if}
    </div>
  </article>
{:else}
  <p>{data.filter === 'all' ? 'You have not judged anything yet.' : 'Nothing matches this filter.'}</p>
{/each}

<nav class="pager">
  {#if data.page > 1}
    <a href={judgmentsHref(data.filter, data.page - 1)}>Newer</a>
  {/if}
  {#if data.hasMore}
    <a href={judgmentsHref(data.filter, data.page + 1)}>Older</a>
  {/if}
</nav>

<p><a href="/play" data-sveltekit-preload-data="off">Back to judging</a></p>

<style>
  .judgment {
    display: flex;
    gap: 1rem;
    padding: 0.75rem 0;
    border-bottom: 1px solid var(--border);
  }
  p {
    margin: 0.15rem 0;
  }
  .filters {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
    margin: 0.75rem 0;
  }
  .filters a.active {
    font-weight: bold;
    text-decoration: none;
  }
  .state.correct {
    color: var(--gold);
  }
  .pager {
    display: flex;
    gap: 1rem;
    margin: 1rem 0;
  }
</style>
