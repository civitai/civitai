<script lang="ts">
  import {
    Chart,
    chartColor,
    createSyncedCrosshair,
  } from '@civitai/ui/components/ui/chart/index.js';
  import EdgeMedia from '$lib/components/EdgeMedia.svelte';
  import ChartTypeToggle from '$lib/components/ChartTypeToggle.svelte';
  import DeltaChip from '$lib/components/DeltaChip.svelte';
  import AnalyticsHeader from '$lib/components/AnalyticsHeader.svelte';
  import { chartType } from '$lib/stores/chart-type';
  import { formatRange, dayDiff, shiftIso } from '$lib/date-range';
  import { IconArrowLeft, IconExternalLink } from '@tabler/icons-svelte';
  import type { TimePoint } from '$lib/server/analytics';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
  // Views, reactions and comments share a date axis, so one crosshair ties the three charts together — hovering
  // a spike in views shows what engagement did on the same day.
  const crosshair = createSyncedCrosshair();
  const num = (n: number) => n.toLocaleString();
  const periodLabel = $derived(`for ${formatRange(data.range)}`);
  const mmdd = (d: string) => (d.length >= 10 ? d.slice(5, 10) : d);

  const image = $derived(data.image);
  const civitaiUrl = $derived(
    `https://civitai.${image.nsfwLevel > 3 ? 'red' : 'com'}/images/${image.imageId}`
  );

  const peak = $derived(
    image.series.reduce((best, p) => (p.value > best.value ? p : best), { date: '', value: 0 })
  );

  const chartData = $derived.by(() => {
    const delta = dayDiff(data.range.from, data.compare.from);
    const prevByDate = new Map(data.compareSeries.map((p) => [p.date, p.value]));
    return {
      labels: image.series.map((p) => mmdd(p.date)),
      datasets: [
        {
          label: 'Views',
          // Stop at `through` so the un-elapsed tail of the month doesn't read as a collapse to zero.
          data: image.series.map((p) => (p.date <= data.through ? p.value : null)),
          borderColor: chartColor(5),
          backgroundColor: chartColor(5),
          tension: 0.3,
          fill: false,
          pointRadius: image.series.length > 45 ? 0 : 2,
        },
        ...(data.compareSeries.length
          ? [
              {
                type: 'line' as const,
                label: data.compare.label,
                data: image.series.map((p) => {
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
  });

  const chartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { display: false } },
    interaction: { mode: 'index' as const, intersect: false },
    elements: { point: { hoverRadius: 5, hitRadius: 16 } },
    scales: {
      x: { ticks: { maxTicksLimit: 8, autoSkip: true, maxRotation: 0, align: 'inner' as const } },
      y: { beginAtZero: true },
    },
  };

  // Engagement sits in its own charts rather than as extra series on the views chart: views run in the
  // thousands and reactions in the tens, so a shared y-axis flattens reactions into the axis line.
  function simpleSeries(series: TimePoint[], label: string, colorIndex: number) {
    return {
      labels: series.map((p) => mmdd(p.date)),
      datasets: [
        {
          label,
          data: series.map((p) => (p.date <= data.through ? p.value : null)),
          borderColor: chartColor(colorIndex),
          backgroundColor: chartColor(colorIndex),
          tension: 0.3,
          fill: false,
          pointRadius: series.length > 45 ? 0 : 2,
        },
      ],
    };
  }

  // Images and videos are both tracked for impressions, so 0 here is a real zero and stays on screen — the
  // absent case is an entity TYPE with no impression arm, which never reaches this page.
  const engagementCharts = $derived([
    {
      title: 'Feed impressions',
      total: image.impressionTotal,
      series: image.impressionSeries,
      color: 7,
    },
    {
      title: 'Reactions',
      total: image.reactionTotal,
      series: image.reactionSeries,
      color: 0,
    },
    {
      title: 'Comments',
      total: image.commentTotal,
      series: image.commentSeries,
      color: 3,
    },
  ]);
</script>

<AnalyticsHeader range={data.range} compare={data.compare} />

<div class="mb-4">
  <!-- Back to the tab this came from. The entity carries its own media type, so a video never sends you to
       the images tab. -->
  <a
    href="/analytics/content{image.type === 'video' ? '?tab=videos' : ''}"
    class="mb-1 inline-flex items-center gap-1 text-xs text-dark-2 hover:text-white"
  >
    <IconArrowLeft size={13} />
    {image.type === 'video' ? 'All videos' : 'All images'}
  </a>
  <h2 class="flex items-center gap-2 text-xl font-semibold text-white">
    {image.type === 'video' ? 'Video' : 'Image'} #{image.imageId}
    <a
      href={civitaiUrl}
      target="_blank"
      rel="noreferrer"
      class="text-dark-3 hover:text-white"
      aria-label="View on Civitai"
    >
      <IconExternalLink size={16} />
    </a>
  </h2>
</div>

<div class="mb-4 flex flex-wrap gap-4">
  <div class="w-40 shrink-0 overflow-hidden rounded-lg border border-dark-4 bg-dark-7">
    <EdgeMedia
      src={image.url}
      type={image.type}
      width={450}
      alt="Image #{image.imageId}"
      class="h-40 w-full object-cover"
    />
  </div>

  <div class="grid flex-1 grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
    <div class="cs-panel p-3">
      <p class="text-xs text-dark-2">Views</p>
      <div class="mt-1 flex items-baseline gap-2">
        <p class="text-xl font-semibold text-white">{num(image.total)}</p>
        <DeltaChip current={image.total} previous={image.prevTotal} />
      </div>
    </div>
    <div class="cs-panel p-3">
      <p class="text-xs text-dark-2">All-time views</p>
      <p class="mt-1 text-xl font-semibold text-white">{num(image.lifetime)}</p>
    </div>
    <div class="cs-panel p-3">
      <p class="text-xs text-dark-2">Best day</p>
      {#if peak.value > 0}
        <p class="mt-1 text-xl font-semibold text-white">{num(peak.value)}</p>
        <p class="text-xs text-dark-3">{peak.date}</p>
      {:else}
        <p class="mt-1 text-xl font-semibold text-dark-4">—</p>
      {/if}
    </div>
    <div class="cs-panel p-3">
      <p class="text-xs text-dark-2">Reactions</p>
      <p class="mt-1 text-xl font-semibold text-white">{num(image.reactionTotal)}</p>
    </div>
    <div class="cs-panel p-3">
      <p class="text-xs text-dark-2">Comments</p>
      <p class="mt-1 text-xl font-semibold text-white">{num(image.commentTotal)}</p>
    </div>
    <div class="cs-panel p-3">
      <p class="text-xs text-dark-2">Feed impressions</p>
      <p class="mt-1 text-xl font-semibold text-white">{num(image.impressionTotal)}</p>
    </div>
  </div>
</div>

<div class="cs-panel p-4">
  <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
    <p class="text-sm font-medium text-white">
      Views over time
      <span class="text-xs text-dark-3">· dashed = {data.compare.label}</span>
    </p>
    <ChartTypeToggle />
  </div>
  {#if image.lifetime === 0}
    <div class="flex h-40 items-center justify-center text-center text-sm text-dark-3">
      This image hasn't been viewed yet.
    </div>
  {:else}
    <div class="h-72">
      {#key chartType.value}
        <Chart
          type={chartType.value}
          data={chartData}
          options={chartOptions}
          plugins={[crosshair]}
          class="h-full"
        />
      {/key}
    </div>
  {/if}
</div>

<div class="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
  {#each engagementCharts as c (c.title)}
    <div class="cs-panel p-4">
      <p class="mb-3 text-sm font-medium text-white">
        {c.title} over time
        <span class="text-xs text-dark-3">· {num(c.total)}</span>
      </p>
      {#if c.total === 0}
        <div class="flex h-48 items-center justify-center text-center text-sm text-dark-3">
          No {c.title.toLowerCase()}
          {periodLabel}.
        </div>
      {:else}
        <div class="h-48">
          {#key chartType.value}
            <Chart
              type={chartType.value}
              data={simpleSeries(c.series, c.title, c.color)}
              options={chartOptions}
              plugins={[crosshair]}
              class="h-full"
            />
          {/key}
        </div>
      {/if}
    </div>
  {/each}
</div>
