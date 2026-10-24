<script lang="ts">
  import { getBrowsingLevelLabel } from '@civitai/shared';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { dateTime, num } from '$lib/format';
  import type { PageData } from './$types';

  type Result = NonNullable<PageData['result']>;

  let { metrics, tags }: { metrics: Result['metrics']; tags: Result['tags'] } = $props();

  const stats = $derived<[string, number][]>(
    metrics
      ? [
          ['Downloads', metrics.downloadCount],
          ['Generations', metrics.generationCount],
          ['Thumbs up', metrics.thumbsUpCount],
          ['Thumbs down', metrics.thumbsDownCount],
          ['Comments', metrics.commentCount],
          ['Collected', metrics.collectedCount],
          ['Tips', metrics.tippedCount],
          ['Buzz tipped', metrics.tippedAmountCount],
          ['Buzz earned', metrics.earnedAmount],
        ]
      : []
  );
</script>

<section class="mb-4 grid gap-4 lg:grid-cols-2">
  <div class="rounded-xl border border-dark-4 bg-dark-6 p-5">
    <h3 class="mb-3 text-sm font-semibold text-white">Engagement</h3>
    {#if !metrics}
      <p class="text-sm text-dark-2">No metric row — this model has never been aggregated.</p>
    {:else}
      <dl class="grid grid-cols-2 gap-x-8 gap-y-2 text-sm sm:grid-cols-3">
        {#each stats as [label, value] (label)}
          <div>
            <dt class="text-xs tracking-wide text-dark-2 uppercase">{label}</dt>
            <dd class="text-dark-0">{num(value)}</dd>
          </div>
        {/each}
      </dl>
      <p class="mt-3 text-xs text-dark-2">Aggregated {dateTime(metrics.updatedAt)}.</p>
    {/if}
  </div>

  <div class="rounded-xl border border-dark-4 bg-dark-6 p-5">
    <h3 class="mb-1 text-sm font-semibold text-white">Tags ({tags.length})</h3>
    <p class="mb-3 text-xs text-dark-2">
      A tag carrying its own rating is what pulls the model's effective level up.
    </p>
    {#if tags.length === 0}
      <p class="text-sm text-dark-2">Untagged.</p>
    {:else}
      <div class="flex flex-wrap gap-1">
        {#each tags as t (t.id)}
          <Badge variant={t.nsfwLevel > 1 ? 'destructive' : 'secondary'}>
            {t.name}{t.nsfwLevel > 1 ? ` · ${getBrowsingLevelLabel(t.nsfwLevel)}` : ''}
          </Badge>
        {/each}
      </div>
    {/if}
  </div>
</section>
