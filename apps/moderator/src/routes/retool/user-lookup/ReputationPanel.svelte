<script lang="ts">
  import type { PageData } from './$types';
  import { num } from './format';

  type Stats = NonNullable<NonNullable<PageData['result']>['stats']>;

  let { stats }: { stats: Stats } = $props();

  const rows = $derived<[string, string][]>([
    ['Followers', num(stats.followers)],
    ['Following', num(stats.following)],
    ['Uploads', num(stats.uploads)],
    ['Downloads', num(stats.downloads)],
    ['Thumbs up', num(stats.thumbsUp)],
    ['Thumbs down', num(stats.thumbsDown)],
    ['Generations', num(stats.generations)],
  ]);
</script>

<section class="rounded-xl border border-dark-4 bg-dark-6 p-5">
  <h3 class="mb-3 text-sm font-semibold text-white">Reputation</h3>
  <div class="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
    {#each rows as [label, value] (label)}
      <div>
        <div class="text-xl font-semibold tabular-nums text-white">{value}</div>
        <div class="text-xs text-dark-2">{label}</div>
      </div>
    {/each}
  </div>
</section>
