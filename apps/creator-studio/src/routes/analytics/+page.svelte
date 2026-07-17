<script lang="ts">
  import { Chart, chartColor, createSyncedCrosshair } from '@civitai/ui/components/ui/chart/index.js';
  import { Card, CardContent } from '@civitai/ui/components/ui/card/index.js';
  import DeltaChip from '$lib/components/DeltaChip.svelte';
  import { IconHeart, IconUserPlus, IconPhoto, IconArticle, IconEye } from '@tabler/icons-svelte';
  import { formatRange, rangeSpanDays, shiftIso } from '$lib/date-range';
  import type { TimePoint } from '$lib/server/analytics';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  // One shared crosshair across every chart on the page — all share the same date axis.
  const crosshair = createSyncedCrosshair();
  const num = (n: number) => n.toLocaleString();
  const periodLabel = $derived(`for ${formatRange(data.range)}`);
  // "YYYY-MM-DD" → "MM-DD" for the x-axis (shorter labels; less edge overhang).
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
    // Prior-period overlay: a muted dashed line, each point aligned to the current date it compares against.
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

  const tiles = $derived(
    data.analytics
      ? [
          { label: 'Reactions', value: data.analytics.totals.reactions, prev: data.analyticsPrev?.totals.reactions ?? null, icon: IconHeart, color: '#ff6b6b' },
          { label: 'New followers', value: data.analytics.totals.followers, prev: data.analyticsPrev?.totals.followers ?? null, icon: IconUserPlus, color: '#4dabf7' },
          { label: 'Images posted', value: data.analytics.totals.images, prev: data.analyticsPrev?.totals.images ?? null, icon: IconPhoto, color: '#9775fa' },
          { label: 'Posts published', value: data.analytics.totals.posts, prev: data.analyticsPrev?.totals.posts ?? null, icon: IconArticle, color: '#3bc9db' },
          { label: 'Profile views', value: data.analytics.totals.profileViews, prev: data.analyticsPrev?.totals.profileViews ?? null, icon: IconEye, color: '#20c997' },
        ]
      : []
  );

  const secondaryCharts = $derived(
    data.analytics
      ? [
          { title: 'New followers', series: data.analytics.followers, prev: data.analyticsPrev?.followers, color: 1 },
          { title: 'Images posted', series: data.analytics.images, prev: data.analyticsPrev?.images, color: 2 },
          { title: 'Posts published', series: data.analytics.posts, prev: data.analyticsPrev?.posts, color: 3 },
          { title: 'Profile views', series: data.analytics.profileViews, prev: data.analyticsPrev?.profileViews, color: 4 },
        ]
      : []
  );

  const hasActivity = $derived(
    !!data.analytics && Object.values(data.analytics.totals).some((v) => v > 0)
  );
</script>

{#if !data.analytics}
  <div class="placeholder">Analytics are temporarily unavailable — please try again shortly.</div>
{:else if !hasActivity}
  <div class="placeholder">
    No activity {periodLabel}. Once your images get reactions, followers, or views, they'll show up here.
  </div>
{:else}
  <p class="mb-2 text-xs text-dark-3">Totals {periodLabel}</p>
  <section class="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-5">
    {#each tiles as tile (tile.label)}
      {@const Icon = tile.icon}
      <Card>
        <CardContent>
          <div class="flex items-center gap-1.5">
            <Icon size={15} color={tile.color} />
            <p class="text-xs uppercase tracking-wide text-dark-3">{tile.label}</p>
          </div>
          <div class="mt-1 flex items-baseline gap-2">
            <p class="text-xl font-semibold text-white">{num(tile.value)}</p>
            <DeltaChip current={tile.value} previous={tile.prev} />
          </div>
        </CardContent>
      </Card>
    {/each}
  </section>
  {#if data.allTime}
    <p class="mb-6 text-xs text-dark-3">
      All-time on your images: <strong class="text-dark-1">{num(data.allTime.reactions)}</strong> reactions ·
      <strong class="text-dark-1">{num(data.allTime.comments)}</strong> comments
    </p>
  {/if}

  <div class="mb-4 rounded-lg border border-dark-4 bg-dark-6 p-4">
    <p class="mb-3 text-sm text-dark-2">Reactions received over time</p>
    <div class="h-64">
      <Chart type="line" data={lineData(data.analytics.reactions, 'Reactions', 0, data.analyticsPrev?.reactions)} options={commonOptions} plugins={[crosshair]} class="h-full" />
    </div>
  </div>

  <div class="grid grid-cols-1 gap-4 lg:grid-cols-2">
    {#each secondaryCharts as c (c.title)}
      <div class="rounded-lg border border-dark-4 bg-dark-6 p-4">
        <p class="mb-3 text-sm text-dark-2">{c.title}</p>
        <div class="h-48">
          <Chart type="line" data={lineData(c.series, c.title, c.color, c.prev)} options={commonOptions} plugins={[crosshair]} class="h-full" />
        </div>
      </div>
    {/each}
  </div>
{/if}
