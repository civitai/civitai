<script lang="ts">
  import { Chart } from '@civitai/ui/components/ui/chart/index.js';
  import { EARNINGS_SOURCES, SOURCE_LABEL, currencyMeta, currencySort, formatAmount } from '$lib/earnings';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  const RANGES = [7, 30, 90] as const;
  const link = (days: number, g: 'day' | 'week') => `?days=${days}&g=${g}`;
  const periodLabel = $derived(`over the last ${data.days} days`);

  // Currencies present, in a stable family order — never merged across families (B8/D1).
  const currencies = $derived(
    data.summary ? [...new Set(data.summary.map((b) => b.currency))].sort(currencySort) : []
  );
  const currencyTotals = $derived(
    currencies.map((c) => ({
      currency: c,
      total: (data.summary ?? []).filter((b) => b.currency === c).reduce((s, b) => s + b.total, 0),
    }))
  );
  // Sources present, in canonical order.
  const sources = $derived(EARNINGS_SOURCES.filter((s) => (data.summary ?? []).some((b) => b.source === s)));
  const cell = (source: string, currency: string) =>
    (data.summary ?? []).find((b) => b.source === source && b.currency === currency)?.total ?? 0;

  const hasEarnings = $derived((data.summary?.length ?? 0) > 0);

  // Trend is buzz-only: buzz colors share one unit (a common y-axis), whereas cash is USD and settles in lumpy
  // monthly batches — a poor daily trend line and unmixable on the same axis. Cash totals live in the cards/table.
  const chartData = $derived.by(() => {
    const series = (data.series ?? []).filter((p) => currencyMeta(p.currency).family === 'buzz');
    const dates = [...new Set(series.map((p) => p.date))].sort();
    const curs = [...new Set(series.map((p) => p.currency))].sort(currencySort);
    return {
      labels: dates,
      datasets: curs.map((c) => ({
        label: currencyMeta(c).label,
        data: dates.map((d) => series.find((p) => p.date === d && p.currency === c)?.total ?? 0),
        borderColor: currencyMeta(c).color,
        backgroundColor: currencyMeta(c).color,
        tension: 0.3,
        fill: false,
        pointRadius: dates.length > 45 ? 0 : 2,
      })),
    };
  });

  const chartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index' as const, intersect: false },
    plugins: { legend: { display: true, position: 'bottom' as const, labels: { color: '#a6a7ab' } } },
    scales: { x: { ticks: { maxTicksLimit: 8, autoSkip: true } } },
  };
</script>

<header class="page-header flex flex-wrap items-start gap-3">
  <div>
    <h1>Earnings</h1>
    <p>What you earned and where it came from — shown in the currency received, without conversion.</p>
  </div>
  <div class="ml-auto flex items-center gap-2">
    <div class="flex items-center gap-1 rounded-lg border border-dark-4 bg-dark-6 p-0.5">
      {#each RANGES as r (r)}
        <a
          href={link(r, data.granularity)}
          class="rounded px-2.5 py-1 text-sm {data.days === r
            ? 'bg-blue-8 text-white'
            : 'text-dark-2 hover:text-white'}"
        >
          {r}d
        </a>
      {/each}
    </div>
    <div class="flex items-center gap-1 rounded-lg border border-dark-4 bg-dark-6 p-0.5">
      {#each ['day', 'week'] as const as g (g)}
        <a
          href={link(data.days, g)}
          class="rounded px-2.5 py-1 text-sm capitalize {data.granularity === g
            ? 'bg-blue-8 text-white'
            : 'text-dark-2 hover:text-white'}"
        >
          {g}
        </a>
      {/each}
    </div>
  </div>
</header>

{#if !data.summary}
  <div class="placeholder">Earnings are temporarily unavailable — please try again shortly.</div>
{:else if !hasEarnings}
  <div class="placeholder">No earnings {periodLabel}. Set licensing fees or access prices to start earning.</div>
{:else}
  <p class="mb-2 text-xs text-dark-3">Totals {periodLabel}</p>
  <section class="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
    {#each currencyTotals as t (t.currency)}
      <div class="rounded-lg border border-dark-4 bg-dark-6 p-3">
        <p class="text-xs uppercase tracking-wide text-dark-3">{currencyMeta(t.currency).label}</p>
        <p class="mt-1 text-xl font-semibold text-white">{formatAmount(t.total, t.currency)}</p>
      </div>
    {/each}
  </section>

  <div class="mb-6 rounded-lg border border-dark-4 bg-dark-6 p-4">
    <p class="mb-3 text-sm text-dark-2">
      Buzz earned over time <span class="text-xs text-dark-3">· cash totals shown in the cards above</span>
    </p>
    <div class="h-72">
      <Chart type="line" data={chartData} options={chartOptions} class="h-full" />
    </div>
  </div>

  <div class="rounded-lg border border-dark-4 bg-dark-6 p-4">
    <p class="mb-3 text-sm text-dark-2">By source <span class="text-xs text-dark-3">{periodLabel}</span></p>
    <div class="overflow-x-auto">
      <table class="w-full text-sm">
        <thead>
          <tr class="border-b border-dark-4 text-left text-xs uppercase tracking-wide text-dark-3">
            <th class="py-2 pr-4 font-medium">Source</th>
            {#each currencies as c (c)}
              <th class="py-2 pl-4 text-right font-medium">{currencyMeta(c).label}</th>
            {/each}
          </tr>
        </thead>
        <tbody>
          {#each sources as s (s)}
            <tr class="border-b border-dark-6">
              <td class="py-2 pr-4 text-dark-1">{SOURCE_LABEL[s]}</td>
              {#each currencies as c (c)}
                {@const v = cell(s, c)}
                <td class="py-2 pl-4 text-right {v ? 'font-medium text-white' : 'text-dark-4'}">
                  {v ? formatAmount(v, c) : '—'}
                </td>
              {/each}
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  </div>
{/if}

<div class="mt-8 rounded-lg border border-dashed border-dark-4 p-4 text-sm text-dark-3">
  <strong class="text-dark-2">Per-model earnings</strong> — breaking earnings down by individual model waits on
  the owner-keyed rollup (<strong>A1 Part 2</strong>); these totals are creator-level.
</div>
