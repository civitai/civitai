<script lang="ts">
  import { Chart, chartColor, createSyncedCrosshair } from '@civitai/ui/components/ui/chart/index.js';
  import EdgeMedia from '$lib/components/EdgeMedia.svelte';
  import RangeSelector from '$lib/components/RangeSelector.svelte';
  import { formatRange } from '$lib/date-range';
  import type { TimePoint } from '$lib/server/analytics';
  import { formatAmount, currencyMeta, currencySort } from '$lib/earnings';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  // One shared crosshair across every chart on the page — all share the same date axis, so hovering one draws a
  // vertical line at that date on all of them.
  const crosshair = createSyncedCrosshair();

  const num = (n: number) => n.toLocaleString();
  const periodLabel = $derived(`for ${formatRange(data.range)}`);
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

  // Per-model performance: one column per currency present (buzz colors + cash) so each value is identifiable by
  // its header — currencies are never merged (B8). Cell is the model's total in that currency, or 0.
  const modelCurrencies = $derived(
    data.modelPerformance
      ? [...new Set(data.modelPerformance.flatMap((m) => m.currencies.map((c) => c.currency)))].sort(currencySort)
      : []
  );
  const modelCell = (m: NonNullable<PageData['modelPerformance']>[number], currency: string) =>
    m.currencies.find((c) => c.currency === currency)?.total ?? 0;
</script>

<header class="page-header flex flex-wrap items-start gap-3">
  <div>
    <h1>Analytics</h1>
    <p>Your content performance — reactions, followers, and posts over time.</p>
  </div>
  <div class="ml-auto">
    <RangeSelector range={data.range} />
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
  <section class="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-5">
    {#each tiles as tile (tile.label)}
      <div class="rounded-lg border border-dark-4 bg-dark-6 p-3">
        <p class="text-xs uppercase tracking-wide text-dark-3">{tile.label}</p>
        <p class="mt-1 text-xl font-semibold text-white">{num(tile.value)}</p>
      </div>
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
      <Chart type="line" data={lineData(data.analytics.reactions, 'Reactions', 0)} options={commonOptions} plugins={[crosshair]} class="h-full" />
    </div>
  </div>

  <div class="grid grid-cols-1 gap-4 lg:grid-cols-2">
    {#each secondaryCharts as c (c.title)}
      <div class="rounded-lg border border-dark-4 bg-dark-6 p-4">
        <p class="mb-3 text-sm text-dark-2">{c.title}</p>
        <div class="h-48">
          <Chart type="line" data={lineData(c.series, c.title, c.color)} options={commonOptions} plugins={[crosshair]} class="h-full" />
        </div>
      </div>
    {/each}
  </div>

  {#if data.analytics.topImages.length > 0}
    <div class="mt-4 rounded-lg border border-dark-4 bg-dark-6 p-4">
      <p class="mb-3 text-sm text-dark-2">
        Top images by reactions <span class="text-xs text-dark-3">{periodLabel}</span>
      </p>
      <div class="grid grid-cols-3 gap-3 sm:grid-cols-4 lg:grid-cols-5">
        {#each data.analytics.topImages as img, i (img.imageId)}
          <!-- mature (nsfwLevel > 3) links to civitai.red; deleted images are filtered out server-side -->
          <a
            href="https://civitai.{img.nsfwLevel > 3 ? 'red' : 'com'}/images/{img.imageId}"
            target="_blank"
            rel="noreferrer"
            class="group relative block aspect-square overflow-hidden rounded-lg border border-dark-4 bg-dark-7"
          >
            <EdgeMedia
              src={img.url}
              type={img.type}
              width={450}
              alt="Top image #{img.imageId}"
              class="h-full w-full object-cover transition-transform group-hover:scale-105"
            />
            <div
              class="absolute inset-x-0 top-0 flex justify-start bg-linear-to-b from-black/60 to-transparent px-2 py-1"
            >
              <span class="text-xs font-semibold text-white">#{i + 1}</span>
            </div>
            <div
              class="absolute inset-x-0 bottom-0 flex justify-end bg-linear-to-t from-black/70 to-transparent px-2 py-1.5"
            >
              <span class="text-xs font-semibold text-white">♥ {num(img.reactions)}</span>
            </div>
          </a>
        {/each}
      </div>
    </div>
  {/if}
{/if}

{#if data.modelPerformance && data.modelPerformance.length > 0}
  <div class="mt-4 rounded-lg border border-dark-4 bg-dark-6 p-4">
    <p class="mb-3 text-sm text-dark-2">
      Per-model performance <span class="text-xs text-dark-3">{periodLabel} · ranked by generations</span>
    </p>
    <div class="overflow-x-auto">
      <table class="w-full text-sm">
        <thead>
          <tr class="border-b border-dark-4 text-left text-xs uppercase tracking-wide text-dark-3">
            <th class="py-2 pr-4 font-medium">Model</th>
            <th class="py-2 pr-4 font-medium">Type</th>
            <th class="py-2 pl-4 text-right font-medium">Generations</th>
            <th class="py-2 pl-4 text-right font-medium">Downloads</th>
            {#each modelCurrencies as c (c)}
              <th class="py-2 pl-4 text-right font-medium">{currencyMeta(c).label}</th>
            {/each}
          </tr>
        </thead>
        <tbody>
          {#each data.modelPerformance as m (m.modelVersionId)}
            <tr class="border-b border-dark-6">
              <td class="py-2 pr-4">
                {#if m.modelId}
                  <!-- NSFW models link to civitai.red (mature domain), same split as the top-images grid -->
                  <a
                    href="https://civitai.{m.nsfw ? 'red' : 'com'}/models/{m.modelId}?modelVersionId={m.modelVersionId}"
                    target="_blank"
                    rel="noreferrer"
                    class="text-dark-1 hover:text-white hover:underline"
                  >
                    {m.modelName ?? `Model ${m.modelId}`}
                  </a>
                {:else}
                  <span class="text-dark-2">Version {m.modelVersionId}</span>
                {/if}
                {#if m.versionName}<span class="text-dark-3"> · {m.versionName}</span>{/if}
              </td>
              <td class="py-2 pr-4 text-dark-2">{m.modelType ?? '—'}</td>
              <td class="py-2 pl-4 text-right {m.generations ? 'text-white' : 'text-dark-4'}">
                {m.generations ? num(m.generations) : '—'}
              </td>
              <td class="py-2 pl-4 text-right {m.downloads ? 'text-white' : 'text-dark-4'}">
                {m.downloads ? num(m.downloads) : '—'}
              </td>
              {#each modelCurrencies as c (c)}
                {@const v = modelCell(m, c)}
                <td class="py-2 pl-4 text-right {v ? 'font-medium text-white' : 'text-dark-4'}">
                  {v ? formatAmount(v, c) : '—'}
                </td>
              {/each}
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  </div>
{:else if data.modelPerformance === null}
  <div class="placeholder mt-4">Per-model performance is temporarily unavailable — please try again shortly.</div>
{:else}
  <div class="mt-4 rounded-lg border border-dashed border-dark-4 p-4 text-sm text-dark-3">
    <strong class="text-dark-2">Per-model performance</strong> — no model activity {periodLabel} yet.
  </div>
{/if}
