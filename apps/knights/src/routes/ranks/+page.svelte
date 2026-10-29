<script lang="ts">
  import StatusBar from '$lib/StatusBar.svelte';
  import { count, percent } from '$lib/format';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
</script>

<h1>Ranks of the Knights of New Order</h1>

<StatusBar status={data.status} />

<table>
  <thead>
    <tr>
      <th>Rank</th>
      <th>Levels</th>
      <th>Accuracy bar</th>
      <th>Vote weight</th>
      <th>Gold</th>
      <th>Daily gold cap</th>
    </tr>
  </thead>
  <tbody>
    {#each data.ranks as rank (rank.rank)}
      <tr class:mine={rank.rank === data.status.rank}>
        <th scope="row">{rank.rank}</th>
        <td>{rank.levels}</td>
        <td>{percent(rank.accuracyBar)}</td>
        <td>{rank.voteWeight}x</td>
        <td>{rank.goldMultiplier}x</td>
        <td>{count(rank.dailyGoldCap)}</td>
      </tr>
    {/each}
  </tbody>
</table>

<ul class="muted">
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

<style>
  table {
    border-collapse: collapse;
    margin: 1rem 0;
  }
  th,
  td {
    padding: 0.4rem 1rem 0.4rem 0;
    text-align: left;
    border-bottom: 1px solid var(--border);
  }
  .mine {
    color: var(--gold);
  }
</style>
