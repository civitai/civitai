<script lang="ts">
  import RankCards from '$lib/RankCards.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
</script>

<div class="page-wide">
  <p class="eyebrow">Knights of New Order</p>
  <h1 class="page-title">Ranks of the Order</h1>

  <RankCards ranks={data.ranks} current={data.status.rank} />

  <div class="divider" aria-hidden="true"><span></span></div>

  <ul class="notes">
    <li>
      Your accuracy is the share of your last {data.rules.window} graded judgments that were right.
      Until {data.rules.minGraded} are graded you are not yet rated, and no bar applies.
    </li>
    <li>
      You rise to a rank when you reach its level and your accuracy meets its bar, and you can skip
      ranks when you meet both for a higher one.
    </li>
    <li>
      Below the bar of your own rank, your vote weight and gold are multiplied by {data.rules
        .belowBarFactor}. You keep your rank and level, and recover by judging well.
    </li>
  </ul>

  <p><a href="/play" data-sveltekit-preload-data="off">Back</a></p>
</div>

<style>
  .notes {
    max-width: 44rem;
    margin: 0 0 1.5rem;
    padding: 0;
    list-style: none;
    color: var(--io-parchment-muted);
  }
  .notes li {
    margin-bottom: 0.75rem;
  }
</style>
