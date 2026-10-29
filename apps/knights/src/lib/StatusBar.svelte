<script lang="ts">
  import type { Snippet } from 'svelte';
  import { percent } from '$lib/format';
  import type { PlayerStatus } from '$lib/server/player-status';

  let {
    status,
    position,
    links,
  }: { status: PlayerStatus; position?: Snippet; links?: Snippet } = $props();
</script>

<p class="status">
  {status.rank} · Level {status.level} · {status.xpIntoLevel}/{status.xpForNextLevel} XP
  {@render position?.()}
</p>
<p class="status">
  Fervor {status.fervor} · Gold {status.goldEarned} earned, {status.goldPending} pending · <a href="/gold">Convert</a>
  {@render links?.()}
</p>
{#if status.rating.bar !== null}
  <p class="status">
    {#if status.rating.accuracy === null}
      Accuracy: not yet rated, {status.rating.graded}/{status.rating.minGraded} graded
    {:else}
      Accuracy {percent(status.rating.accuracy)} · the bar for a {status.rank} is {percent(status.rating.bar)}
      {#if status.rating.belowBar}
        · <strong class="below">below it: reduced weight and gold</strong>
      {/if}
    {/if}
    · <a href="/ranks">Ranks</a>
  </p>
{/if}
{#if status.nextRank}
  <p class="status">
    Next, {status.nextRank.rank}: level {status.nextRank.fromLevel}{status.nextRank.levelMet ? ' (reached)' : `, ${status.nextRank.levelsToGo} to go`}
    and accuracy of {percent(status.nextRank.accuracyBar)} or more{status.nextRank.accuracyMet ? ' (reached)' : ''}
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
