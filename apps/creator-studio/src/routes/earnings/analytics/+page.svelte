<script lang="ts">
  import { Chart, chartColor } from '@civitai/ui/components/ui/chart/index.js';
  import type { TimePoint } from '$lib/server/analytics';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  const RANGES = [7, 30, 90] as const;
  const num = (n: number) => n.toLocaleString();

  const commonOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { display: false } },
    scales: { x: { ticks: { maxTicksLimit: 7 } } },
  };

  function lineData(series: TimePoint[], label: string, colorIndex: number) {
    return {
      labels: series.map((p) => p.date),
      datasets: [
        {
          label,
          data: series.map((p) => p.value),
          borderColor: chartColor(colorIndex),
          backgroundColor: chartColor(colorIndex),
          tension: 0.3,
          fill: false,
          pointRadius: 2,
        },
      ],
    };
  }

  const tiles = $derived(
    data.analytics
      ? [
          { label: 'Reactions', value: data.analytics.totals.reactions },
          { label: 'New followers', value: data.analytics.totals.followers },
          { label: 'Images posted', value: data.analytics.totals.images },
          { label: 'Posts published', value: data.analytics.totals.posts },
          { label: 'Profile views', value: data.analytics.totals.profileViews },
        ]
      : []
  );

  const secondaryCharts = $derived(
    data.analytics
      ? [
          { title: 'New followers', series: data.analytics.followers, color: 1 },
          { title: 'Images posted', series: data.analytics.images, color: 2 },
          { title: 'Posts published', series: data.analytics.posts, color: 3 },
          { title: 'Profile views', series: data.analytics.profileViews, color: 4 },
        ]
      : []
  );
</script>

<header class="page-header flex items-start gap-3">
  <div>
    <h1>Analytics</h1>
    <p>Your content performance — reactions, followers, and posts over time.</p>
  </div>
  <div class="ml-auto flex items-center gap-1 rounded-lg border border-dark-4 bg-dark-6 p-0.5">
    {#each RANGES as r (r)}
      <a
        href="?days={r}"
        class="rounded px-2.5 py-1 text-sm {data.days === r
          ? 'bg-blue-8 text-white'
          : 'text-dark-2 hover:text-white'}"
      >
        {r}d
      </a>
    {/each}
  </div>
</header>

{#if !data.analytics}
  <div class="placeholder">Analytics are temporarily unavailable — please try again shortly.</div>
{:else}
  <section class="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-5">
    {#each tiles as tile (tile.label)}
      <div class="rounded-lg border border-dark-4 bg-dark-6 p-3">
        <p class="text-xs uppercase tracking-wide text-dark-3">{tile.label}</p>
        <p class="mt-1 text-xl font-semibold text-white">{num(tile.value)}</p>
      </div>
    {/each}
  </section>

  <div class="mb-4 rounded-lg border border-dark-4 bg-dark-6 p-4">
    <p class="mb-3 text-sm text-dark-2">Reactions received over time</p>
    <div class="h-64">
      <Chart type="line" data={lineData(data.analytics.reactions, 'Reactions', 0)} options={commonOptions} class="h-full" />
    </div>
  </div>

  <div class="grid grid-cols-1 gap-4 lg:grid-cols-2">
    {#each secondaryCharts as c (c.title)}
      <div class="rounded-lg border border-dark-4 bg-dark-6 p-4">
        <p class="mb-3 text-sm text-dark-2">{c.title}</p>
        <div class="h-48">
          <Chart type="line" data={lineData(c.series, c.title, c.color)} options={commonOptions} class="h-full" />
        </div>
      </div>
    {/each}
  </div>
{/if}

<div class="mt-8 rounded-lg border border-dashed border-dark-4 p-4 text-sm text-dark-3">
  <strong class="text-dark-2">Model usage & earnings</strong> — generations, downloads, and per-model earnings
  are keyed by model version, so they wait on the owner-keyed rollup (<strong>A1</strong>) before they can be
  charted here.
</div>
