<script lang="ts">
  import { Chart, chartColor } from '@civitai/ui/components/ui/chart/index.js';
  import EdgeMedia from '$lib/components/EdgeMedia.svelte';
  import ChartTypeToggle from '$lib/components/ChartTypeToggle.svelte';
  import DeltaChip from '$lib/components/DeltaChip.svelte';
  import AnalyticsHeader from '$lib/components/AnalyticsHeader.svelte';
  import { chartType } from '$lib/stores/chart-type';
  import { formatRange } from '$lib/date-range';
  import { IconArrowLeft, IconExternalLink } from '@tabler/icons-svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
  const num = (n: number) => n.toLocaleString();
  const periodLabel = $derived(`for ${formatRange(data.range)}`);
  const mmdd = (d: string) => (d.length >= 10 ? d.slice(5, 10) : d);

  const model = $derived(data.detail);
  const civitaiUrl = $derived(
    `https://civitai.${model.nsfwLevel > 3 ? 'red' : 'com'}/3d-models/${model.model3dId}`
  );

  const peak = $derived(
    model.series.reduce((best, p) => (p.value > best.value ? p : best), { date: '', value: 0 })
  );

  // Views only. There is no reaction arm for Model3D in the `reactions` type enum, so engagement is absent
  // rather than zero — a panel reading 0 would claim something the data cannot say.
  const chartData = $derived({
    labels: model.series.map((p) => mmdd(p.date)),
    datasets: [
      {
        label: 'Views',
        data: model.series.map((p) => (p.date <= data.through ? p.value : null)),
        borderColor: chartColor(5),
        backgroundColor: chartColor(5),
        tension: 0.3,
        fill: false,
        pointRadius: model.series.length > 45 ? 0 : 2,
      },
    ],
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
</script>

<AnalyticsHeader range={data.range} compare={data.compare} />

<div class="mb-4">
  <a
    href="/analytics/content?tab=model3ds"
    class="mb-1 inline-flex items-center gap-1 text-xs text-dark-2 hover:text-white"
  >
    <IconArrowLeft size={13} /> All 3D models
  </a>
  <h2 class="flex items-center gap-2 text-xl font-semibold text-white">
    {model.name}
    <a
      href={civitaiUrl}
      target="_blank"
      rel="noreferrer"
      class="shrink-0 text-dark-3 hover:text-white"
      aria-label="View on Civitai"
    >
      <IconExternalLink size={16} />
    </a>
  </h2>
  <p class="text-sm text-dark-3">
    Detail-page views{model.published ? '' : ' · not published'}
  </p>
</div>

<div class="mb-4 flex flex-wrap gap-4">
  {#if model.coverUrl}
    <div class="w-40 shrink-0 overflow-hidden rounded-lg border border-dark-4 bg-dark-7">
      <EdgeMedia
        src={model.coverUrl}
        type="image"
        width={450}
        alt=""
        class="h-40 w-full object-cover"
      />
    </div>
  {/if}

  <div class="grid flex-1 grid-cols-2 gap-3 sm:grid-cols-3">
    <div class="cs-panel p-3">
      <p class="text-xs text-dark-2">Views</p>
      <div class="mt-1 flex items-baseline gap-2">
        <p class="text-xl font-semibold text-white">{num(model.total)}</p>
        <DeltaChip current={model.total} previous={model.prevTotal} />
      </div>
    </div>
    <div class="cs-panel p-3">
      <p class="text-xs text-dark-2">All-time views</p>
      <p class="mt-1 text-xl font-semibold text-white">{num(model.lifetime)}</p>
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
  </div>
</div>

<div class="cs-panel p-4">
  <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
    <p class="text-sm font-medium text-white">Views over time</p>
    <ChartTypeToggle />
  </div>
  {#if !model.tracking}
    <div class="flex h-40 items-center justify-center text-center text-sm text-dark-3">
      View tracking hasn't started collecting for 3D models yet.
    </div>
  {:else if model.lifetime === 0}
    <div class="flex h-40 items-center justify-center text-center text-sm text-dark-3">
      This 3D model hasn't been viewed yet.
    </div>
  {:else}
    <div class="h-72">
      {#key chartType.value}
        <Chart type={chartType.value} data={chartData} options={chartOptions} class="h-full" />
      {/key}
    </div>
  {/if}
</div>
