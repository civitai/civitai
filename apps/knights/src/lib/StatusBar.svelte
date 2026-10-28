<script lang="ts">
  import type { Snippet } from 'svelte';
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
  Fervor {status.fervor} · Gold {status.goldEarned} earned, {status.goldPending} pending
  {@render links?.()}
</p>
<div class="bar" aria-hidden="true">
  <div class="fill" style:width="{status.progressPercent}%"></div>
</div>

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
</style>
