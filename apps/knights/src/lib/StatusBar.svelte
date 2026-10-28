<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { PlayerStatus } from '$lib/server/player-status';

  let {
    status,
    position,
    links,
  }: { status: PlayerStatus; position?: Snippet; links?: Snippet } = $props();

  const percent = (ratio: number) => `${Math.round(ratio * 1000) / 10}%`;
  let rating = $derived(status.rating);
  let next = $derived(status.nextRank);
</script>

<p class="status">
  {status.rank} · Level {status.level} · {status.xpIntoLevel}/{status.xpForNextLevel} XP
  {@render position?.()}
</p>
<p class="status">
  Fervor {status.fervor} · Gold {status.goldEarned} earned, {status.goldPending} pending
  {@render links?.()}
</p>
{#if rating.bar !== null}
  <p class="status">
    {#if rating.accuracy === null}
      Accuracy: not yet rated, {rating.graded}/{rating.minGraded} graded
    {:else}
      Accuracy {percent(rating.accuracy)} · the bar for a {status.rank} is {percent(rating.bar)}
      {#if rating.belowBar}
        · <strong class="below">below it: reduced weight and gold</strong>
      {/if}
    {/if}
    · <a href="/ranks">Ranks</a>
  </p>
{/if}
{#if next}
  <p class="status">
    Next, {next.rank}: level {next.fromLevel}{next.levelMet ? ' (reached)' : `, ${next.levelsToGo} to go`}
    and accuracy of {percent(next.accuracyBar)} or more{next.accuracyMet ? ' (reached)' : ''}
  </p>
{/if}
<div class="bar" aria-hidden="true">
  <div class="fill" style:width="{status.progressPercent}%"></div>
</div>

<style>
  .status {
    margin: 0 0 0.25rem;
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
</style>
