<script lang="ts">
  import { Chart, chartColor } from '@civitai/ui/components/ui/chart/index.js';
  import type { TimePoint } from '$lib/server/analytics';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  const RANGES = [7, 30, 90] as const;
  const num = (n: number) => n.toLocaleString();
  // Build a URL that preserves both controls.
  const link = (days: number, g: 'day' | 'week') => `?days=${days}&g=${g}`;
  const periodLabel = $derived(`over the last ${data.days} days`);
  // "YYYY-MM-DD" → "MM-DD" for the x-axis (shorter labels; less edge overhang than the full date).
  const mmdd = (d: string) => (d.length >= 10 ? d.slice(5, 10) : d);

  const commonOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { display: false } },
    // Trigger the tooltip anywhere along a date column, not only when the cursor sits exactly on a point.
    interaction: { mode: 'index' as const, intersect: false },
    elements: { point: { hoverRadius: 5, hitRadius: 16 } },
    scales: {
      x: { ticks: { maxTicksLimit: 8, autoSkip: true, maxRotation: 0, align: 'inner' as const } },
    },
  };

  function lineData(series: TimePoint[], label: string, colorIndex: number) {
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

  // Distinguish "loaded but nothing happened this period" from "failed to load" so a new creator doesn't just
  // see flat-zero charts with no explanation.
  const hasActivity = $derived(
    !!data.analytics && Object.values(data.analytics.totals).some((v) => v > 0)
  );
</script>

<header class="page-header flex flex-wrap items-start gap-3">
  <div>
    <h1>Analytics</h1>
    <p>Your content performance — reactions, followers, and posts over time.</p>
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

{#if !data.analytics}
  <div class="placeholder">Analytics are temporarily unavailable — please try again shortly.</div>
{:else if !hasActivity}
  <div class="placeholder">
    No activity {periodLabel}. Once your images get reactions, followers, or views, they'll show up here.
  </div>
{:else}
  <p class="mb-2 text-xs text-dark-3">Totals {periodLabel}</p>
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

  {#if data.analytics.topImages.length > 0}
    <div class="mt-4 rounded-lg border border-dark-4 bg-dark-6 p-4">
      <p class="mb-3 text-sm text-dark-2">
        Top images by reactions <span class="text-xs text-dark-3">{periodLabel}</span>
      </p>
      <table class="w-full text-sm">
        <thead>
          <tr class="border-b border-dark-4 text-left text-xs uppercase tracking-wide text-dark-3">
            <th class="w-10 py-2 font-medium">#</th>
            <th class="py-2 font-medium">Image</th>
            <th class="w-28 py-2 text-right font-medium">Reactions</th>
          </tr>
        </thead>
        <tbody>
          {#each data.analytics.topImages as img, i (img.imageId)}
            <tr class="border-b border-dark-6">
              <td class="py-2 text-dark-3">{i + 1}</td>
              <td class="py-2">
                <a
                  href="https://civitai.com/images/{img.imageId}"
                  target="_blank"
                  rel="noreferrer"
                  class="text-white underline decoration-dark-4 hover:decoration-white"
                >
                  Image #{img.imageId}
                </a>
              </td>
              <td class="py-2 text-right font-medium text-white">{num(img.reactions)}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
{/if}

<div class="mt-8 rounded-lg border border-dashed border-dark-4 p-4 text-sm text-dark-3">
  <strong class="text-dark-2">Model usage & earnings</strong> — generations, downloads, and per-model earnings
  are keyed by model version, so they wait on the owner-keyed rollup (<strong>A1</strong>) before they can be
  charted here.
</div>
