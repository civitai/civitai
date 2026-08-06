<script lang="ts">
  import type { PageData } from './$types';
  import { num } from './format';

  type Result = NonNullable<PageData['result']>;

  let {
    reportsFiled,
    reportedContent,
  }: { reportsFiled: Result['reportsFiled']; reportedContent: Result['reportedContent'] } =
    $props();

  const filed = $derived<[string, string][]>([
    ['Total', num(reportsFiled.total)],
    ['Actioned', num(reportsFiled.actioned)],
    ['Dismissed', num(reportsFiled.unactioned)],
    ['Pending', num(reportsFiled.pending)],
  ]);
</script>

<section class="mb-4 grid gap-4 lg:grid-cols-2">
  <div class="rounded-xl border border-dark-4 bg-dark-6 p-5">
    <h3 class="mb-1 text-sm font-semibold text-white">Reports they filed</h3>
    <p class="mb-3 text-xs text-dark-2">
      How often their reports hold up — the actioned share is of resolved reports only.
    </p>
    <div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {#each filed as [label, value] (label)}
        <div>
          <div class="text-xl font-semibold tabular-nums text-white">{value}</div>
          <div class="text-xs text-dark-2">{label}</div>
        </div>
      {/each}
    </div>
    {#if reportsFiled.actionedPercent !== null}
      <p class="mt-3 text-sm text-dark-1">
        <span class="font-semibold text-white">{reportsFiled.actionedPercent}%</span>
        of their resolved reports were actioned.
      </p>
    {/if}
  </div>

  <div class="rounded-xl border border-dark-4 bg-dark-6 p-5">
    <h3 class="mb-1 text-sm font-semibold text-white">Their content that was reported</h3>
    <p class="mb-3 text-xs text-dark-2">
      Distinct items with at least one report, not the number of reports.
    </p>
    <div class="grid grid-cols-2 gap-3 sm:grid-cols-3">
      {#each reportedContent as item (item.label)}
        <div>
          <div
            class="text-xl font-semibold tabular-nums {item.count > 0
              ? 'text-white'
              : 'text-dark-2'}"
          >
            {num(item.count)}
          </div>
          <div class="text-xs text-dark-2">{item.label}</div>
        </div>
      {/each}
    </div>
  </div>
</section>
