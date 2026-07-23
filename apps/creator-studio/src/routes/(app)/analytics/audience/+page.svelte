<script lang="ts">
  import { Chart, chartColor } from '@civitai/ui/components/ui/chart/index.js';
  import StatCard from '$lib/components/StatCard.svelte';
  import DeltaChip from '$lib/components/DeltaChip.svelte';
  import ChartTypeToggle from '$lib/components/ChartTypeToggle.svelte';
  import { chartType } from '$lib/stores/chart-type';
  import { IconUserPlus, IconHeart, IconMessage } from '@tabler/icons-svelte';
  import { formatRange, dayDiff, shiftIso } from '$lib/date-range';
  import type { TimePoint } from '$lib/server/analytics';
  import AnalyticsHeader from '$lib/components/AnalyticsHeader.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
  const num = (n: number) => n.toLocaleString();
  const periodLabel = $derived(`for ${formatRange(data.range)}`);
  const mmdd = (d: string) => (d.length >= 10 ? d.slice(5, 10) : d);

  const commonOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { display: false } },
    interaction: { mode: 'index' as const, intersect: false },
    elements: { point: { hoverRadius: 5, hitRadius: 16 } },
    scales: {
      x: { ticks: { maxTicksLimit: 8, autoSkip: true, maxRotation: 0, align: 'inner' as const } },
    },
  };

  function lineData(series: TimePoint[], label: string, colorIndex: number, prevSeries: TimePoint[] = []) {
    const delta = dayDiff(data.range.from, data.compare.from);
    const prevByDate = new Map(prevSeries.map((p) => [p.date, p.value]));
    return {
      labels: series.map((p) => mmdd(p.date)),
      datasets: [
        {
          label,
          // Gap-filled to month end; stop the line at today so a partial current month doesn't dip to zero.
          data: series.map((p) => (p.date <= data.through ? p.value : null)),
          borderColor: chartColor(colorIndex),
          backgroundColor: chartColor(colorIndex),
          tension: 0.3,
          fill: false,
          pointRadius: series.length > 45 ? 0 : 2,
        },
        ...(prevSeries.length
          ? [
              {
                type: 'line' as const,
                label: data.compare.label,
                // Stop the comparison line where its (possibly shorter) month ends.
                data: series.map((p) => {
                  const cd = shiftIso(p.date, delta);
                  return cd <= data.compare.to ? (prevByDate.get(cd) ?? 0) : null;
                }),
                borderColor: '#868e96',
                backgroundColor: '#868e96',
                borderDash: [4, 4],
                tension: 0.3,
                fill: false,
                pointRadius: 0,
              },
            ]
          : []),
      ],
    };
  }
</script>

<AnalyticsHeader range={data.range} compare={data.compare} />

{#if !data.analytics}
  <div class="placeholder">Audience analytics are temporarily unavailable — please try again shortly.</div>
{:else}
  <section class="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
    <StatCard label="New followers" icon={IconUserPlus} color="#4dabf7">
      <div class="mt-1 flex items-baseline gap-2">
        <p class="text-xl font-semibold text-white">{num(data.analytics.totals.followers)}</p>
        <DeltaChip current={data.analytics.totals.followers} previous={data.analyticsPrev?.totals.followers ?? null} />
      </div>
    </StatCard>
    {#if data.allTime}
      <StatCard label="All-time reactions" icon={IconHeart} color="#ff6b6b">
        <p class="mt-1 text-xl font-semibold text-white">{num(data.allTime.reactions)}</p>
      </StatCard>
      <StatCard label="All-time comments" icon={IconMessage} color="#20c997">
        <p class="mt-1 text-xl font-semibold text-white">{num(data.allTime.comments)}</p>
      </StatCard>
    {/if}
  </section>

  <div class="grid grid-cols-1 gap-4 lg:grid-cols-2">
    <div class="cs-panel p-4">
      <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p class="text-sm font-medium text-white">New followers over time <span class="text-xs text-dark-3">{periodLabel}</span></p>
        <ChartTypeToggle />
      </div>
      <div class="h-64">
        {#key chartType.value}
          <Chart type={chartType.value} data={lineData(data.analytics.followers, 'New followers', 1, data.analyticsPrev?.followers)} options={commonOptions} class="h-full" />
        {/key}
      </div>
    </div>
    <div class="cs-panel p-4">
      <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p class="text-sm font-medium text-white">Reactions received over time <span class="text-xs text-dark-3">{periodLabel}</span></p>
        <ChartTypeToggle />
      </div>
      <div class="h-64">
        {#key chartType.value}
          <Chart type={chartType.value} data={lineData(data.analytics.reactions, 'Reactions', 0, data.analyticsPrev?.reactions)} options={commonOptions} class="h-full" />
        {/key}
      </div>
    </div>
  </div>

  <!-- Comments have no fast period-scoped source (all-time only, see getAllTimeTotals), so there's no
       comments-over-time chart yet — tracked in the round-5 checklist. -->
{/if}
