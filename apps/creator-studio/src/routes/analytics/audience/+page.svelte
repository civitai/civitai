<script lang="ts">
  import { Chart, chartColor } from '@civitai/ui/components/ui/chart/index.js';
  import { Card, CardContent } from '@civitai/ui/components/ui/card/index.js';
  import DeltaChip from '$lib/components/DeltaChip.svelte';
  import { IconUserPlus, IconHeart, IconMessage } from '@tabler/icons-svelte';
  import { formatRange, rangeSpanDays, shiftIso } from '$lib/date-range';
  import type { TimePoint } from '$lib/server/analytics';
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
    const span = rangeSpanDays(data.range);
    const prevByDate = new Map(prevSeries.map((p) => [p.date, p.value]));
    return {
      labels: series.map((p) => mmdd(p.date)),
      datasets: [
        {
          label,
          data: series.map((p) => p.value),
          borderColor: chartColor(colorIndex),
          backgroundColor: chartColor(colorIndex),
          tension: 0.3,
          fill: false,
          pointRadius: series.length > 45 ? 0 : 2,
        },
        ...(prevSeries.length
          ? [
              {
                label: 'Previous period',
                data: series.map((p) => prevByDate.get(shiftIso(p.date, -span)) ?? 0),
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

{#if !data.analytics}
  <div class="placeholder">Audience analytics are temporarily unavailable — please try again shortly.</div>
{:else}
  <section class="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
    <Card>
      <CardContent>
        <div class="flex items-center gap-1.5">
          <IconUserPlus size={15} color="#4dabf7" />
          <p class="text-xs uppercase tracking-wide text-dark-3">New followers</p>
        </div>
        <div class="mt-1 flex items-baseline gap-2">
          <p class="text-xl font-semibold text-white">{num(data.analytics.totals.followers)}</p>
          <DeltaChip current={data.analytics.totals.followers} previous={data.analyticsPrev?.totals.followers ?? null} />
        </div>
      </CardContent>
    </Card>
    {#if data.allTime}
      <Card>
        <CardContent>
          <div class="flex items-center gap-1.5">
            <IconHeart size={15} color="#ff6b6b" />
            <p class="text-xs uppercase tracking-wide text-dark-3">All-time reactions</p>
          </div>
          <p class="mt-1 text-xl font-semibold text-white">{num(data.allTime.reactions)}</p>
        </CardContent>
      </Card>
      <Card>
        <CardContent>
          <div class="flex items-center gap-1.5">
            <IconMessage size={15} color="#20c997" />
            <p class="text-xs uppercase tracking-wide text-dark-3">All-time comments</p>
          </div>
          <p class="mt-1 text-xl font-semibold text-white">{num(data.allTime.comments)}</p>
        </CardContent>
      </Card>
    {/if}
  </section>

  <div class="rounded-lg border border-dark-4 bg-dark-6 p-4">
    <p class="mb-3 text-sm text-dark-2">New followers over time <span class="text-xs text-dark-3">{periodLabel}</span></p>
    <div class="h-64">
      <Chart type="line" data={lineData(data.analytics.followers, 'New followers', 1, data.analyticsPrev?.followers)} options={commonOptions} class="h-full" />
    </div>
  </div>
{/if}
