<script lang="ts">
  import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
  } from '@civitai/ui/components/ui/table/index.js';
  import type { PageData } from './$types';
  import { dateTime, num } from '$lib/format';

  type Metrics = NonNullable<PageData['result']>['metrics'];

  let { metrics }: { metrics: Metrics } = $props();

  const COLUMNS = [
    ['Views', 'viewCount'],
    ['Comments', 'commentCount'],
    ['Likes', 'likeCount'],
    ['Dislikes', 'dislikeCount'],
    ['Hearts', 'heartCount'],
    ['Laughs', 'laughCount'],
    ['Cries', 'cryCount'],
    ['Favorites', 'favoriteCount'],
    ['Collected', 'collectedCount'],
    ['Hidden', 'hideCount'],
    ['Tips', 'tippedCount'],
    ['Tipped buzz', 'tippedAmountCount'],
  ] as const;
</script>

<section class="mb-4 rounded-xl border border-dark-4 bg-dark-6 p-5">
  <h3 class="mb-1 text-sm font-semibold text-white">Metrics</h3>
  <p class="mb-3 text-xs text-dark-2">
    One row per timeframe. A large gap between Day and AllTime is the shape of a sudden spike.
  </p>

  {#if metrics.length === 0}
    <p class="text-sm text-dark-2">No metrics recorded for this article.</p>
  {:else}
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Timeframe</TableHead>
          {#each COLUMNS as [label] (label)}
            <TableHead class="text-right">{label}</TableHead>
          {/each}
          <TableHead>Updated</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {#each metrics as row (row.timeframe)}
          <TableRow>
            <TableCell class="text-dark-0">{row.timeframe}</TableCell>
            {#each COLUMNS as [label, key] (label)}
              <TableCell class="text-right tabular-nums text-dark-0">{num(row[key])}</TableCell>
            {/each}
            <TableCell class="text-xs text-dark-2">{dateTime(row.updatedAt)}</TableCell>
          </TableRow>
        {/each}
      </TableBody>
    </Table>
  {/if}
</section>
