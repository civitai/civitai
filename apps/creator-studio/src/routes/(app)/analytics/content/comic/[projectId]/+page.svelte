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
  import { formatRange } from '$lib/date-range';
  import { IconArrowLeft, IconExternalLink } from '@tabler/icons-svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
  // Views and reads share a date axis, so one crosshair ties them together — the useful question is whether a
  // spike in overview views turned into chapter reads.
  const crosshair = createSyncedCrosshair();
  const num = (n: number) => n.toLocaleString();
  const periodLabel = $derived(`for ${formatRange(data.range)}`);
  const mmdd = (d: string) => (d.length >= 10 ? d.slice(5, 10) : d);

  const comic = $derived(data.detail);
  const civitaiUrl = $derived(
    `https://civitai.${comic.nsfwLevel > 3 ? 'red' : 'com'}/comics/${comic.projectId}`
  );

  // No comparison-month overlay here: the panel already plots two series, and a dashed twin for each would
  // make four lines on one axis. The period-over-period signal lives in the delta chip instead.
  const chartData = $derived.by(() => {
    return {
      labels: comic.series.map((p) => mmdd(p.date)),
      datasets: [
        {
          label: 'Views',
          data: comic.series.map((p) => (p.date <= data.through ? p.value : null)),
          borderColor: chartColor(5),
          backgroundColor: chartColor(5),
          tension: 0.3,
          fill: false,
          pointRadius: comic.series.length > 45 ? 0 : 2,
        },
        {
          // Reads are a different entity type, not a subset of views — no row is counted in both.
          type: 'line' as const,
          label: 'Chapter reads',
          data: comic.readSeries.map((p) => (p.date <= data.through ? p.value : null)),
          borderColor: chartColor(3),
          backgroundColor: chartColor(3),
          tension: 0.3,
          fill: false,
          pointRadius: comic.readSeries.length > 45 ? 0 : 2,
        },
      ],
    };
  });

  const chartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { display: true, position: 'bottom' as const, labels: { boxWidth: 12 } } },
    interaction: { mode: 'index' as const, intersect: false },
    elements: { point: { hoverRadius: 5, hitRadius: 16 } },
    scales: {
      x: { ticks: { maxTicksLimit: 8, autoSkip: true, maxRotation: 0, align: 'inner' as const } },
      y: { beginAtZero: true },
    },
  };

  const peakReads = $derived(Math.max(1, ...comic.chapters.map((c) => c.reads)));
</script>

<AnalyticsHeader range={data.range} compare={data.compare} />

<div class="mb-4">
  <a
    href="/analytics/content?tab=comics"
    class="mb-1 inline-flex items-center gap-1 text-xs text-dark-2 hover:text-white"
  >
    <IconArrowLeft size={13} /> All comics
  </a>
  <h2 class="flex items-center gap-2 text-xl font-semibold text-white">
    {comic.name}
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
    Overview views and chapter reads{comic.published ? '' : ' · not published'}
  </p>
</div>

<div class="mb-4 flex flex-wrap gap-4">
  {#if comic.coverUrl}
    <div class="w-40 shrink-0 overflow-hidden rounded-lg border border-dark-4 bg-dark-7">
      <EdgeMedia
        src={comic.coverUrl}
        type="image"
        width={450}
        alt=""
        class="h-40 w-full object-cover"
      />
    </div>
  {/if}

  <div class="grid flex-1 grid-cols-2 gap-3 sm:grid-cols-4">
    <div class="cs-panel p-3">
      <p class="text-xs text-dark-2">Views</p>
      <div class="mt-1 flex items-baseline gap-2">
        <p class="text-xl font-semibold text-white">{num(comic.total)}</p>
        <DeltaChip current={comic.total} previous={comic.prevTotal} />
      </div>
    </div>
    <div class="cs-panel p-3">
      <p class="text-xs text-dark-2">Chapter reads</p>
      <p class="mt-1 text-xl font-semibold text-white">{num(comic.readTotal)}</p>
    </div>
    <div class="cs-panel p-3">
      <p class="text-xs text-dark-2">All-time views</p>
      <p class="mt-1 text-xl font-semibold text-white">{num(comic.lifetime)}</p>
    </div>
    <div class="cs-panel p-3">
      <p class="text-xs text-dark-2">Chapters</p>
      <p class="mt-1 text-xl font-semibold text-white">{comic.chapters.length}</p>
    </div>
  </div>
</div>

<div class="cs-panel p-4">
  <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
    <p class="text-sm font-medium text-white">Views and reads over time</p>
    <ChartTypeToggle />
  </div>
  {#if !comic.tracking}
    <div class="flex h-40 items-center justify-center text-center text-sm text-dark-3">
      View tracking hasn't started collecting for comics yet.
    </div>
  {:else if comic.lifetime === 0 && comic.readTotal === 0}
    <div class="flex h-40 items-center justify-center text-center text-sm text-dark-3">
      This comic hasn't been viewed yet.
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

{#if comic.chapters.length}
  <div class="mt-4 cs-panel p-4">
    <p class="mb-3 text-sm font-medium text-white">
      Reads by chapter
      <span class="text-xs text-dark-3">· in reading order, so the fall-off is the drop-off</span>
    </p>
    <div class="flex flex-col gap-2">
      {#each comic.chapters as c (c.chapterId)}
        <div class="flex items-center gap-3">
          <span class="w-40 shrink-0 truncate text-xs text-dark-2" title={c.name}>{c.name}</span>
          <div class="h-3 flex-1 overflow-hidden rounded bg-dark-6">
            <div
              class="h-full rounded bg-blue-5"
              style="width: {Math.round((c.reads / peakReads) * 100)}%"
            ></div>
          </div>
          <span class="w-16 shrink-0 text-right text-xs tabular-nums text-white">
            {num(c.reads)}
          </span>
        </div>
      {/each}
    </div>
  </div>
{/if}
