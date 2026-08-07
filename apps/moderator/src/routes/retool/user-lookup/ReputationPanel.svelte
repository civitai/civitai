<script lang="ts">
  import type { PageData } from './$types';
  import { num } from '$lib/format';

  type Result = NonNullable<PageData['result']>;
  type Stats = Result['stats'];
  type Scores = Result['scores'];
  type Ranks = Result['ranks'];

  let { stats, scores, ranks }: { stats: Stats; scores: Scores; ranks: Ranks } = $props();

  const rows = $derived<[string, string][]>(
    stats
      ? [
          ['Followers', num(stats.followers)],
          ['Following', num(stats.following)],
          ['Uploads', num(stats.uploads)],
          ['Downloads', num(stats.downloads)],
          ['Thumbs up', num(stats.thumbsUp)],
          ['Thumbs down', num(stats.thumbsDown)],
          ['Generations', num(stats.generations)],
        ]
      : []
  );

  // Only components that were actually computed. A missing key is "not scored", not zero — rendering it
  // as 0 would read as a user who scored nothing.
  const scoreRows = $derived(
    (
      [
        ['Users', scores?.users],
        ['Images', scores?.images],
        ['Models', scores?.models],
        ['Articles', scores?.articles],
        ['Reports against', scores?.reportsAgainst],
        ['Reports actioned', scores?.reportsActioned],
      ] as [string, number | null | undefined][]
    ).filter((entry): entry is [string, number] => typeof entry[1] === 'number')
  );
</script>

<section class="mb-4 rounded-xl border border-dark-4 bg-dark-6 p-5">
  <h3 class="mb-3 text-sm font-semibold text-white">Reputation</h3>
  {#if rows.length === 0}
    <p class="text-sm text-dark-2">No recorded stats for this account.</p>
  {:else}
    <div class="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
      {#each rows as [label, value] (label)}
        <div>
          <div class="text-xl font-semibold tabular-nums text-white">{value}</div>
          <div class="text-xs text-dark-2">{label}</div>
        </div>
      {/each}
    </div>
  {/if}

  <div class="mt-5 border-t border-dark-4 pt-4">
    <h4 class="mb-2 text-xs tracking-wide text-dark-2 uppercase">Civitai score</h4>
    {#if !scores || (scores.total === null && scoreRows.length === 0)}
      <p class="text-sm text-dark-2">Not scored.</p>
    {:else}
      <div class="flex flex-wrap items-baseline gap-x-6 gap-y-2">
        {#if scores.total !== null}
          <div>
            <span class="text-xl font-semibold tabular-nums text-white">{num(scores.total)}</span>
            <span class="ml-1 text-xs text-dark-2">total</span>
          </div>
        {/if}
        {#each scoreRows as [label, value] (label)}
          <div class="text-sm">
            <span class="tabular-nums text-dark-0">{num(value)}</span>
            <span class="ml-1 text-xs text-dark-2">{label.toLowerCase()}</span>
          </div>
        {/each}
      </div>
    {/if}
  </div>

  <div class="mt-5 border-t border-dark-4 pt-4">
    <h4 class="mb-2 text-xs tracking-wide text-dark-2 uppercase">
      Leaderboard placements (top 100, last 30 days)
    </h4>
    {#if ranks.length === 0}
      <p class="text-sm text-dark-2">None.</p>
    {:else}
      <div class="flex flex-wrap gap-x-6 gap-y-2">
        {#each ranks as rank (rank.leaderboardId)}
          <div class="text-sm">
            <span class="tabular-nums text-dark-0">#{rank.position}</span>
            <span class="ml-1 text-xs text-dark-2">{rank.leaderboardId}</span>
          </div>
        {/each}
      </div>
    {/if}
  </div>
</section>
