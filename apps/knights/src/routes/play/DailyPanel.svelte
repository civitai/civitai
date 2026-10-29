<script lang="ts">
  import type { DailyStatus } from '$lib/server/daily/daily.service';

  let { daily }: { daily: DailyStatus } = $props();
  const gold = (n: number) => n.toLocaleString('en-US');
</script>

<section class="daily" aria-label="Daily Watch">
  <p class="line">
    Daily Watch
    <progress max={daily.watchSize} value={Math.min(daily.votes, daily.watchSize)}></progress>
    {Math.min(daily.votes, daily.watchSize)}/{daily.watchSize}
    {#if daily.watchDone}
      · complete, +{gold(daily.bonusGold)} gold streak bonus
    {:else}
      · finish it for +{gold(daily.bonusGold)} gold
    {/if}
  </p>
  <p class="line">
    Streak: {daily.streak} {daily.streak === 1 ? 'day' : 'days'}
    · Shields: {daily.shields}/{daily.maxShields}
    {#if daily.streak > 0 && !daily.watchDone}· the streak ends at 00:00 UTC unless you finish today's Watch{/if}
  </p>
  <p class="line">
    {#if daily.capReached}
      <strong class="cap">Gold cap reached for today</strong>
      · judgments still earn XP and count toward the Watch
    {:else}
      Gold recorded today: {gold(daily.goldRecorded)}/{gold(daily.goldCap)}
    {/if}
  </p>
</section>

<style>
  .daily {
    margin-bottom: 1rem;
  }
  .line {
    margin: 0 0 0.25rem;
    color: var(--muted);
  }
  progress {
    width: 8rem;
    margin: 0 0.5rem;
    vertical-align: middle;
    accent-color: var(--gold);
  }
  .cap {
    color: var(--gold);
  }
</style>
