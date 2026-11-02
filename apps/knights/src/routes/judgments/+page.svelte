<script lang="ts">
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
</script>

<h1>Your judgments</h1>

<StatusBar status={data.status} />

{#each data.judgments as judgment (`${judgment.itemId}:${judgment.at}`)}
  <article class="judgment">
    <Thumbnail src={judgment.src} />
    <div>
      <p class="muted">{judgment.prompt}</p>
      <p>Your answer: {judgment.answerLabel}</p>
      <p class="muted">
        <span class="state {judgment.status}">{STATUS_TEXT[judgment.status]}</span>
        · {judgment.xp} XP · {judgment.gold} gold{judgment.status === 'pending' ? ' pending' : ''} · {new Date(judgment.at).toLocaleString()}
      </p>
    </div>
  </article>
{:else}
  <p>You have not judged anything yet.</p>
{/each}

<nav class="pager">
  {#if data.page > 1}
    <a href="/judgments?page={data.page - 1}">Newer</a>
  {/if}
  {#if data.hasMore}
    <a href="/judgments?page={data.page + 1}">Older</a>
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
  .state.correct {
    color: var(--gold);
  }
  .pager {
    display: flex;
    gap: 1rem;
    margin: 1rem 0;
  }
</style>
