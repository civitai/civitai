<script lang="ts">
  import { Chart } from '@civitai/ui/components/ui/chart/index.js';
  import ChartTypeToggle from '$lib/components/ChartTypeToggle.svelte';
  import CurrencyDisplay from '$lib/components/CurrencyDisplay.svelte';
  import { chartType } from '$lib/stores/chart-type';
  import { currencySort } from '$lib/earnings';
  import { dayDiff, shiftIso } from '$lib/date-range';
  import { CHANNEL_COLOR, CHANNEL_LABEL } from '$lib/monetization/admin-channels';
  import type { MonetizationDaily } from '$lib/server/admin/monetization-overview';

  let {
    daily,
    comparison,
    compare,
  }: {
    daily: MonetizationDaily | null;
    comparison: MonetizationDaily | null;
    compare: { key: string; label: string; from: string; to: string };
  } = $props();

  // 'YYYY-MM-DD' → 'MM-DD' for the axis; shorter labels, less edge overhang. Matches the analytics pages.
  const mmdd = (d: string) => (d.length >= 10 ? d.slice(5, 10) : d);

  // The last day the ledger has data for in this range. Everything after it is unelapsed, not zero.
  const through = $derived(daily?.through ?? null);

  const chartData = $derived.by(() => {
    if (!daily) return { labels: [], datasets: [] };
    // The comparison month is lined up by ORDINAL day, so day 3 sits under day 3 — a 30-day month
    // compared against a 31-day one stays like-for-like instead of sliding by a day.
    const delta = dayDiff(daily.days[0] ?? '', compare.from);
    const prevByDate = new Map<string, Map<string, number>>();
    for (const s of comparison?.series ?? []) {
      const byDay = new Map<string, number>();
      (comparison?.days ?? []).forEach((d, i) => byDay.set(d, s.totals[i] ?? 0));
      prevByDate.set(s.channel, byDay);
    }

    return {
      labels: daily.days.map(mmdd),
      datasets: [
        ...daily.series.map((s) => ({
          label: CHANNEL_LABEL[s.channel],
          // 🔴 Stop the line at the last day with data. Carrying zeroes to the end of the month is what
          // made a part-elapsed month read as a collapse — the days simply have not happened yet.
          data: daily.days.map((d, i) => (through && d > through ? null : s.totals[i])),
          borderColor: CHANNEL_COLOR[s.channel],
          backgroundColor: CHANNEL_COLOR[s.channel],
          tension: 0.3,
          fill: false,
          pointRadius: daily.days.length > 45 ? 0 : 2,
          spanGaps: false,
        })),
        // One dashed line per channel, in that channel's own colour, so a move can be attributed to the
        // channel that made it. Always `line` even in bar mode — a second set of bars would compete with
        // the stack rather than read as a baseline behind it.
        ...(comparison
          ? daily.series.map((s) => ({
              type: 'line' as const,
              label: `${CHANNEL_LABEL[s.channel]} · ${compare.label}`,
              data: daily.days.map((d) => {
                const cd = shiftIso(d, delta);
                // The comparison month can be shorter than the selected one; past its end there is no
                // day to compare against, so the line stops rather than dropping to zero.
                return cd > compare.to ? null : (prevByDate.get(s.channel)?.get(cd) ?? 0);
              }),
              borderColor: CHANNEL_COLOR[s.channel],
              backgroundColor: CHANNEL_COLOR[s.channel],
              borderDash: [4, 4],
              borderWidth: 1.5,
              tension: 0.3,
              fill: false,
              pointRadius: 0,
            }))
          : []),
      ],
    };
  });

  const stacked = $derived(chartType.value === 'bar');
  // The comparison datasets are appended after the current-month ones, so anything past that index is a
  // dashed baseline. Kept out of the legend — they carry their channel's colour, so the solid entry
  // already names them, and listing both would double a five-item legend to ten.
  const currentCount = $derived(daily?.series.length ?? 0);
  const chartOptions = $derived({
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        display: true,
        position: 'bottom' as const,
        labels: {
          filter: (item: { datasetIndex?: number }) => (item.datasetIndex ?? 0) < currentCount,
        },
      },
    },
    interaction: { mode: 'index' as const, intersect: false },
    scales: {
      x: { stacked, ticks: { maxTicksLimit: 10, autoSkip: true, maxRotation: 0 } },
      y: { stacked, beginAtZero: true },
    },
  });

  const cash = $derived(
    [...(daily?.cash ?? [])].sort((a, b) => currencySort(a.currency, b.currency))
  );
  const hasData = $derived((daily?.series ?? []).some((s) => s.totals.some((t) => t > 0)));
</script>

<section class="cs-panel mb-6 p-4">
  <div class="mb-3 flex flex-wrap items-start justify-between gap-2">
    <div>
      <p class="m-0 text-sm font-medium text-white">Paid to creators per day</p>
      <p class="m-0 text-xs text-dark-2">
        Buzz only — cash settles on its own schedule and cannot share an axis with Buzz, so it is
        reported below rather than plotted.
      </p>
    </div>
    <ChartTypeToggle />
  </div>

  {#if !daily}
    <p class="placeholder">The chart is unavailable right now.</p>
  {:else if !hasData}
    <p class="placeholder">No creator payouts in this month.</p>
  {:else}
    <div class="h-72">
      <!-- Chart.js mutates its config in place, so the chart is rebuilt when the type changes rather
           than handed a new `type` on the same instance. -->
      {#key chartType.value}
        <Chart type={chartType.value} data={chartData} options={chartOptions} class="h-full" />
      {/key}
    </div>

    {#if cash.length > 0}
      <div class="mt-3 flex flex-wrap gap-x-6 gap-y-1 border-t border-dark-4 pt-3 text-xs">
        <span class="text-dark-2">Cash paid this month</span>
        {#each cash as c (c.currency)}
          <span class="tabular-nums text-white">
            <CurrencyDisplay amount={c.total} currency={c.currency} />
          </span>
        {/each}
      </div>
    {/if}

    <p class="mt-3 text-xs text-dark-2">
      Each line stops at the last day with data, so a month still running does not read as a
      decline. Dashed lines are {compare.label} in the same colour as their channel, lined up day-for-day.
    </p>
  {/if}
</section>
