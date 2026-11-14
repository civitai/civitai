<script lang="ts">
  import type { Snippet } from 'svelte';
  import Icon from '$lib/Icon.svelte';
  import { nextRankLine } from '$lib/chrome';
  import { percent } from '$lib/format';
  import type { PlayerStatus } from '$lib/server/player-status';

  let {
    status,
    position,
    links,
  }: { status: PlayerStatus; position?: Snippet; links?: Snippet } = $props();
  let nextLine = $derived(nextRankLine(status));
  let hearts = $derived(Math.max(0, status.maxSmites - status.smites));
</script>

<p class="status">
  {status.rank} · Level {status.level} · {status.xpIntoLevel}/{status.xpForNextLevel} XP
  {@render position?.()}
</p>
<p class="status">
  <span class="fz"><Icon name="sparkles" size={13} />Fervor {status.fervor}</span> · Gold {status.goldEarned} earned, {status.goldPending} pending
  ·
  <span
    class="hearts"
    role="img"
    aria-label="{hearts} of {status.maxSmites} hearts left"
    title="Each smite costs a heart. Lose all {status.maxSmites} and your career resets."
  >
    {#each { length: status.maxSmites } as _, heart (heart)}
      <span aria-hidden="true" class:lost={heart >= hearts}>{heart < hearts ? '♥' : '♡'}</span>
    {/each}
  </span>
  {@render links?.()}
  · <a href="/codex#judging">Codex</a>
</p>
{#if status.rating.bar !== null}
  <p class="status">
    {#if status.rating.accuracy === null}
      Accuracy: not yet rated, {status.rating.graded}/{status.rating.minGraded} graded
    {:else}
      Accuracy {percent(status.rating.accuracy)} · the bar for a {status.rank} is {percent(status.rating.bar)}
      {#if status.rating.belowBar}
        · <strong class="below">below it: reduced gold</strong>
      {/if}
    {/if}
    · <a href="/codex#ranks">Ranks</a>
  </p>
{/if}
{#if nextLine}
  <p class="status">{nextLine}</p>
{/if}
<div class="bar" aria-hidden="true">
  <div class="fill" style:width="{status.progressPercent}%"></div>
</div>

<style>
  .fz {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }
  .status {
    margin: 0 0 0.25rem;
    color: var(--muted);
  }
  .hearts {
    color: var(--io-crimson-text);
    letter-spacing: 0.1em;
  }
  .hearts .lost {
    color: var(--muted);
  }
  .below {
    color: var(--gold);
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
  @media (max-width: 40rem) {
    .status {
      margin: 0;
      font-size: 0.8rem;
      line-height: 1.35;
    }
    .bar {
      margin: 0.25rem 0 0.5rem;
    }
  }
</style>
