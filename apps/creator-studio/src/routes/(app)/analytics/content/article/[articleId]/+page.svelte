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
  const crosshair = createSyncedCrosshair();
  const num = (n: number) => n.toLocaleString();
  const periodLabel = $derived(`for ${formatRange(data.range)}`);
  const mmdd = (d: string) => (d.length >= 10 ? d.slice(5, 10) : d);

  const article = $derived(data.article);
  const civitaiUrl = $derived(
    `https://civitai.${article.nsfwLevel > 3 ? 'red' : 'com'}/articles/${article.articleId}`
  );

  const peak = $derived(
    article.series.reduce((best, p) => (p.value > best.value ? p : best), { date: '', value: 0 })
  );

  const chartData = $derived.by(() => {
    const delta = dayDiff(data.range.from, data.compare.from);
    const prevByDate = new Map(data.compareSeries.map((p) => [p.date, p.value]));
    return {
      labels: article.series.map((p) => mmdd(p.date)),
      datasets: [
        {
          label: 'Views',
          data: article.series.map((p) => (p.date <= data.through ? p.value : null)),
          borderColor: chartColor(5),
          backgroundColor: chartColor(5),
          tension: 0.3,
          fill: false,
          pointRadius: article.series.length > 45 ? 0 : 2,
        },
        ...(data.compareSeries.length
          ? [
              {
                type: 'line' as const,
                label: data.compare.label,
                data: article.series.map((p) => {
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
</script>

<AnalyticsHeader range={data.range} compare={data.compare} />

<div class="mb-4">
  <a
    href="/analytics/content?tab=articles"
    class="mb-1 inline-flex items-center gap-1 text-xs text-dark-2 hover:text-white"
  >
    <IconArrowLeft size={13} /> All articles
  </a>
  <h2 class="flex items-center gap-2 text-xl font-semibold text-white">
    {article.title}
    <a
      href={civitaiUrl}
      target="_blank"
      rel="noreferrer"
      class="shrink-0 text-dark-3 hover:text-white"
      aria-label="Read on Civitai"
    >
      <IconExternalLink size={16} />
    </a>
  </h2>
  <p class="text-sm text-dark-3">
    Views {periodLabel}.{article.publishedAt
      ? ` Published ${article.publishedAt.slice(0, 10)}.`
      : ' Not published.'}
  </p>
</div>

<div class="mb-4 flex flex-wrap gap-4">
  {#if article.coverUrl}
    <div class="w-40 shrink-0 overflow-hidden rounded-lg border border-dark-4 bg-dark-7">
      <EdgeMedia
        src={article.coverUrl}
        type="image"
        width={450}
        alt=""
        class="h-40 w-full object-cover"
      />
    </div>
  {/if}

  <div class="grid flex-1 grid-cols-2 gap-3 sm:grid-cols-4">
    <div class="cs-panel p-3">
      <p class="text-xs text-dark-2">Views {periodLabel}</p>
      <div class="mt-1 flex items-baseline gap-2">
        <p class="text-xl font-semibold text-white">{num(article.total)}</p>
        <DeltaChip current={article.total} previous={article.prevTotal} />
      </div>
    </div>
    <div class="cs-panel p-3">
      <p class="text-xs text-dark-2">All-time views</p>
      <p class="mt-1 text-xl font-semibold text-white">{num(article.lifetime)}</p>
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
      <p class="text-xs text-dark-2">Reactions {periodLabel}</p>
      <p class="mt-1 text-xl font-semibold text-white">{num(article.reactionTotal)}</p>
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
  {#if article.lifetime === 0}
    <div class="flex h-40 items-center justify-center text-center text-sm text-dark-3">
      This article hasn't been viewed yet.
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

<div class="mt-4 cs-panel p-4">
  <p class="mb-3 text-sm font-medium text-white">
    Reactions over time
    <span class="text-xs text-dark-3">· {num(article.reactionTotal)} {periodLabel}</span>
  </p>
  {#if article.reactionTotal === 0}
    <div class="flex h-48 items-center justify-center text-center text-sm text-dark-3">
      No reactions {periodLabel}.
    </div>
  {:else}
    <div class="h-48">
      {#key chartType.value}
        <Chart
          type={chartType.value}
          data={simpleSeries(article.reactionSeries, 'Reactions', 0)}
          options={chartOptions}
          plugins={[crosshair]}
          class="h-full"
        />
      {/key}
    </div>
  {/if}
</div>
