<script lang="ts">
  import { Chart, chartColor, createSyncedCrosshair } from '@civitai/ui/components/ui/chart/index.js';
  import { Card, CardContent } from '@civitai/ui/components/ui/card/index.js';
  import * as Table from '@civitai/ui/components/ui/table/index.js';
  import EdgeMedia from '$lib/components/EdgeMedia.svelte';
  import RangeSelector from '$lib/components/RangeSelector.svelte';
  import DeltaChip from '$lib/components/DeltaChip.svelte';
  import {
    IconArrowUp,
    IconArrowDown,
    IconArrowsSort,
    IconHeart,
    IconUserPlus,
    IconPhoto,
    IconArticle,
    IconEye,
  } from '@tabler/icons-svelte';
  import { formatRange, rangeSpanDays, shiftIso } from '$lib/date-range';
  import type { TimePoint } from '$lib/server/analytics';
  import { formatAmount, currencyMeta, currencySort, hasDisplayValue } from '$lib/earnings';
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

  function lineData(series: TimePoint[], label: string, colorIndex: number, prevSeries: TimePoint[] = []) {
    // Prior-period overlay: a muted dashed line, each point aligned to the current date it compares against
    // (current date − range span), so it's robust to sparse/uneven dates.
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

  // Client-side sort for the performance table — by generations, downloads, or any currency column. Default
  // matches the server ranking (generations, desc); clicking the active column flips direction.
  let sortKey = $state('generations');
  let sortDir = $state<'asc' | 'desc'>('desc');
  const sortValue = (m: NonNullable<PageData['modelPerformance']>[number], key: string): number =>
    key === 'generations' ? m.generations : key === 'downloads' ? m.downloads : modelCell(m, key);
  function toggleSort(key: string) {
    if (sortKey === key) sortDir = sortDir === 'desc' ? 'asc' : 'desc';
    else {
      sortKey = key;
      sortDir = 'desc';
    }
  }
  const sortedModels = $derived.by(() => {
    const rows = data.modelPerformance ? [...data.modelPerformance] : [];
    const dir = sortDir === 'desc' ? -1 : 1;
    return rows.sort((a, b) => dir * (sortValue(a, sortKey) - sortValue(b, sortKey)));
  });

  // Top images: the server returns up to 50; show a first tranche and let the creator expand to all.
  let showAllImages = $state(false);
  const shownImages = $derived(
    data.analytics
      ? showAllImages
        ? data.analytics.topImages
        : data.analytics.topImages.slice(0, 12)
      : []
  );
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

  {#if data.analytics.topImages.length > 0}
    <div class="mt-4 rounded-lg border border-dark-4 bg-dark-6 p-4">
      <p class="mb-3 text-sm text-dark-2">
        Top images by reactions <span class="text-xs text-dark-3">{periodLabel}</span>
      </p>
      <div class="grid grid-cols-3 gap-3 sm:grid-cols-4 lg:grid-cols-5">
        {#each shownImages as img, i (img.imageId)}
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
      {#if data.analytics.topImages.length > 12}
        <button
          type="button"
          onclick={() => (showAllImages = !showAllImages)}
          class="mt-3 cursor-pointer text-xs text-dark-2 hover:text-white"
        >
          {showAllImages ? 'Show less' : `Show all ${data.analytics.topImages.length}`}
        </button>
      {/if}
    </div>
  {/if}
{/if}

{#if data.modelPerformance && data.modelPerformance.length > 0}
  <div class="mt-4 rounded-lg border border-dark-4 bg-dark-6 p-4">
    <p class="mb-3 text-sm text-dark-2">
      Per-model performance <span class="text-xs text-dark-3">{periodLabel} · click a column to sort</span>
    </p>
    {#snippet sortHead(key: string, label: string)}
      {@const active = sortKey === key}
      <Table.Head class="text-right {active ? 'bg-dark-5/40' : ''}">
        <button
          type="button"
          onclick={() => toggleSort(key)}
          class="flex w-full cursor-pointer items-center justify-end gap-1 hover:text-white {active
            ? 'font-medium text-white'
            : 'text-dark-3'}"
        >
          <span>{label}</span>
          {#if active}
            {#if sortDir === 'asc'}
              <IconArrowUp size={14} class="text-blue-4" />
            {:else}
              <IconArrowDown size={14} class="text-blue-4" />
            {/if}
          {:else}
            <IconArrowsSort size={14} class="text-dark-4" />
          {/if}
        </button>
      </Table.Head>
    {/snippet}
    <Table.Root>
      <Table.Header>
        <Table.Row>
          <Table.Head>Model</Table.Head>
          {@render sortHead('generations', 'Generations')}
          {@render sortHead('downloads', 'Downloads')}
          {#each modelCurrencies as c (c)}
            {@render sortHead(c, currencyMeta(c).label)}
          {/each}
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {#each sortedModels as m (m.modelVersionId)}
          <Table.Row>
            <Table.Cell class="max-w-55">
              <div
                class="truncate"
                title="{m.modelName ?? `Model ${m.modelId}`}{m.versionName ? ` · ${m.versionName}` : ''}"
              >
                {#if m.modelId}
                  <!-- Drill into this model's per-version analytics (feedback 4.5). -->
                  <a href="/analytics/model/{m.modelId}" class="text-dark-1 hover:text-white hover:underline">
                    {m.modelName ?? `Model ${m.modelId}`}
                  </a>
                {:else}
                  <span class="text-dark-2">Version {m.modelVersionId}</span>
                {/if}
                {#if m.versionName}<span class="text-dark-3"> · {m.versionName}</span>{/if}
              </div>
              <div class="truncate text-xs text-dark-3">{m.modelType ?? '—'}</div>
            </Table.Cell>
            <Table.Cell class="text-right {m.generations ? 'text-white' : 'text-dark-4'}">
              {m.generations ? num(m.generations) : '—'}
            </Table.Cell>
            <Table.Cell class="text-right {m.downloads ? 'text-white' : 'text-dark-4'}">
              {m.downloads ? num(m.downloads) : '—'}
            </Table.Cell>
            {#each modelCurrencies as c (c)}
              {@const v = modelCell(m, c)}
              {@const show = hasDisplayValue(v, c)}
              <Table.Cell class="text-right {show ? 'font-medium text-white' : 'text-dark-4'}">
                {show ? formatAmount(v, c) : '—'}
              </Table.Cell>
            {/each}
          </Table.Row>
        {/each}
      </Table.Body>
    </Table.Root>
  </div>
{:else if data.modelPerformance === null}
  <div class="placeholder mt-4">Per-model performance is temporarily unavailable — please try again shortly.</div>
{:else}
  <div class="mt-4 rounded-lg border border-dashed border-dark-4 p-4 text-sm text-dark-3">
    <strong class="text-dark-2">Per-model performance</strong> — no model activity {periodLabel} yet.
  </div>
{/if}
