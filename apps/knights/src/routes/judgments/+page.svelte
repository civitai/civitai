<script lang="ts">
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  const STATUS_TEXT = {
    pending: 'Awaiting the verdict',
    correct: 'Rightly judged',
    wrong: 'Not quite',
    inconclusive: 'Set aside',
  } as const;
</script>

<h1>Your judgments</h1>

{#if data.status}
  {@const status = data.status}
  <p class="status">
    {status.rank} · Level {status.level} · {status.xpIntoLevel}/{status.xpForNextLevel} XP · Fervor {status.fervor}
    · Gold {status.goldEarned} earned, {status.goldPending} pending
  </p>
  <div class="bar" aria-hidden="true">
    <div class="fill" style:width="{status.progressPercent}%"></div>
  </div>
{/if}

{#each data.judgments as judgment (judgment.itemId)}
  <article class="judgment">
    {#if judgment.src}
      <img src={judgment.src} alt="The subject of this judgment" width="96" height="96" />
    {:else}
      <div class="gone" role="img" aria-label="This image is no longer shown"></div>
    {/if}
    <div>
      <p class="prompt">{judgment.prompt}</p>
      <p>Your answer: {judgment.answerLabel}</p>
      <p class="meta">
        <span class="state {judgment.status}">{STATUS_TEXT[judgment.status]}</span>
        · {judgment.xp} XP · {judgment.gold} gold · {new Date(judgment.at).toLocaleString()}
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

<p><a href="/play">Back to judging</a></p>

<style>
  .status {
    margin: 0 0 0.25rem;
    color: var(--muted);
  }
  .bar {
    height: 4px;
    margin-bottom: 1rem;
    background: var(--border);
  }
  .fill {
    height: 100%;
    background: var(--gold);
  }
  .judgment {
    display: flex;
    gap: 1rem;
    padding: 0.75rem 0;
    border-bottom: 1px solid var(--border);
  }
  img,
  .gone {
    flex: none;
    width: 96px;
    height: 96px;
    object-fit: cover;
    border: 1px solid var(--border);
    background: var(--panel);
  }
  p {
    margin: 0.15rem 0;
  }
  .prompt {
    color: var(--muted);
  }
  .meta {
    color: var(--muted);
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
