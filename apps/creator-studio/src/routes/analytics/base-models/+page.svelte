<script lang="ts">
  import * as Table from '@civitai/ui/components/ui/table/index.js';
  import { Chart } from '@civitai/ui/components/ui/chart/index.js';
  import { ToggleGroup, ToggleGroupItem } from '@civitai/ui/components/ui/toggle-group/index.js';
  import ChartTypeToggle from '$lib/components/ChartTypeToggle.svelte';
  import { chartType } from '$lib/stores/chart-type';
  import DeltaChip from '$lib/components/DeltaChip.svelte';
  import {
    IconArrowUp,
    IconArrowDown,
    IconArrowsSort,
    IconChevronLeft,
    IconChevronRight,
  } from '@tabler/icons-svelte';
  import { page } from '$app/state';
  import { setSortParam, setPageParam, pageWindow } from '$lib/table-nav';
  import { formatRange, eachDayIso, shiftIso, dayDiff } from '$lib/date-range';
  import { baseModelTrendSelection } from '$lib/stores/base-model-trend';
  import { formatAmount, currencyMeta, currencySort, hasDisplayValue } from '$lib/earnings';
  import { analyticsPageSize } from '$lib/stores/analytics-page-size';
  import PageSizeSelect from '$lib/components/PageSizeSelect.svelte';
  import AnalyticsHeader from '$lib/components/AnalyticsHeader.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
  const num = (n: number) => n.toLocaleString();
  const periodLabel = $derived(`for ${formatRange(data.range)}`);
  const perPage = $derived(analyticsPageSize.value);

  // Civitai-wide base-model popularity (4.6): pick base models to compare; each draws a solid current-month line
  // plus a dashed comparison-month line (aligned day-for-day). The creator's own base models are starred, and the
  // selection persists to localStorage.
  const TREND_COLORS = [
    '#4dabf7', '#f783ac', '#ffa94d', '#69db7c', '#a78bfa', '#63e6be', '#ff8787', '#ffd43b', '#4dd4c4', '#e599f7',
    '#74c0fc', '#faa2c1', '#ffc078', '#8ce99a', '#b197fc', '#96f2d7', '#ffa8a8', '#ffe066', '#66d9e8', '#eebefa',
  ];
  const DEFAULT_SHOWN = 6;
  const mmdd = (d: string) => (d.length >= 10 ? d.slice(5, 10) : d);
  let trendMetric = $state<'generations' | 'downloads'>('generations');
  const trends = $derived(data.platformTrends ?? []);
  const ownSet = $derived(new Set(data.ownBaseModels ?? []));
  const compareByBase = $derived(
    new Map((data.platformTrendsCompare ?? []).map((t) => [t.baseModel, t]))
  );
  // The togglable universe (top platform base models this month). Effective selection = saved picks that still
  // exist this month, else the top few.
  const universe = $derived(trends.map((t) => t.baseModel));
  const selected = $derived.by(() => {
    const saved = baseModelTrendSelection.value.filter((bm) => universe.includes(bm));
    return saved.length ? saved : universe.slice(0, DEFAULT_SHOWN);
  });
  // Colour keyed to a base model's position in the selected set, so its chip dot matches its line.
  const colorOf = $derived(new Map(selected.map((bm, i) => [bm, TREND_COLORS[i % TREND_COLORS.length]])));
  const shownTrends = $derived(
    selected
      .map((bm) => trends.find((t) => t.baseModel === bm))
      .filter((t): t is (typeof trends)[number] => t != null)
  );

  // Full-month x-axis so a partial current month still renders whole; each line stops at `through` (last day with
  // data) rather than dropping to zero for days that haven't happened.
  const trendDates = $derived(eachDayIso(data.range));
  const compareDelta = $derived(dayDiff(data.range.from, data.compare.from));
  const trendData = $derived.by(() => {
    const current = shownTrends.map((t) => {
      const color = colorOf.get(t.baseModel);
      const byDate = new Map(t.points.map((p) => [p.date, p[trendMetric]]));
      const own = ownSet.has(t.baseModel);
      return {
        label: own ? `★ ${t.baseModel}` : t.baseModel,
        data: trendDates.map((d) => (d <= data.through ? (byDate.get(d) ?? 0) : null)),
        borderColor: color,
        backgroundColor: color,
        borderWidth: own ? 2.75 : 1.5,
        tension: 0.3,
        fill: false,
        pointRadius: 0,
      };
    });
    const compare = shownTrends.map((t) => {
      const color = colorOf.get(t.baseModel);
      const byDate = new Map((compareByBase.get(t.baseModel)?.points ?? []).map((p) => [p.date, p[trendMetric]]));
      return {
        type: 'line' as const,
        label: `${t.baseModel} (${data.compare.label})`,
        data: trendDates.map((d) => {
          const cd = shiftIso(d, compareDelta);
          return cd <= data.compare.to ? (byDate.get(cd) ?? 0) : null;
        }),
        borderColor: color,
        backgroundColor: color,
        borderWidth: 1.25,
        borderDash: [4, 4],
        tension: 0.3,
        fill: false,
        pointRadius: 0,
      };
    });
    return { labels: trendDates.map(mmdd), datasets: [...current, ...compare] };
  });
  const trendHasData = $derived(trends.length > 0);
  // Legend shows only the solid current-month lines — the dashed comparison twins would just double every entry.
  const trendOptions = $derived({
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index' as const, intersect: false },
    plugins: {
      legend: {
        display: true,
        position: 'bottom' as const,
        labels: {
          boxWidth: 12,
          font: { size: 11 },
          filter: (item: { datasetIndex?: number }) => (item.datasetIndex ?? 0) < shownTrends.length,
        },
      },
    },
    scales: { x: { ticks: { maxTicksLimit: 8, autoSkip: true, maxRotation: 0 } }, y: { beginAtZero: true } },
  });

  const currencies = $derived(
    data.baseModels
      ? [...new Set(data.baseModels.flatMap((b) => b.currencies.map((c) => c.currency)))].sort(currencySort)
      : []
  );
  const cell = (b: NonNullable<PageData['baseModels']>[number], currency: string) =>
    b.currencies.find((c) => c.currency === currency) ?? { currency, total: 0, prev: 0 };

  const sortKey = $derived(page.url.searchParams.get('sort') ?? 'generations');
  const sortDir = $derived(page.url.searchParams.get('dir') === 'asc' ? 'asc' : 'desc');
  const pageNum = $derived(Math.max(1, Number(page.url.searchParams.get('page')) || 1));

  const sortValue = (b: NonNullable<PageData['baseModels']>[number], key: string): number =>
    key === 'models'
      ? b.modelCount
      : key === 'generations'
        ? b.generations
        : key === 'downloads'
          ? b.downloads
          : cell(b, key).total;
  const sorted = $derived.by(() => {
    const rows = data.baseModels ? [...data.baseModels] : [];
    const dir = sortDir === 'desc' ? -1 : 1;
    return rows.sort((a, b) => dir * (sortValue(a, sortKey) - sortValue(b, sortKey)));
  });
  const totalPages = $derived(Math.max(1, Math.ceil(sorted.length / perPage)));
  const curPage = $derived(Math.min(pageNum, totalPages));
  const pageRows = $derived(sorted.slice((curPage - 1) * perPage, curPage * perPage));
</script>

<AnalyticsHeader range={data.range} compare={data.compare} />

{#if trendHasData}
  <div class="mb-4 cs-panel p-4">
    <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
      <p class="text-sm font-medium text-white">
        Civitai-wide base-model usage
        <span class="text-xs text-dark-3">
          · {trendMetric} {periodLabel} · dashed = {data.compare.label} · ★ marks yours
        </span>
      </p>
      <div class="flex flex-wrap items-center gap-2">
        <ToggleGroup
          type="single"
          value={trendMetric}
          onValueChange={(v: string) => {
            if (v) trendMetric = v as 'generations' | 'downloads';
          }}
          variant="outline"
          size="sm"
        >
          <ToggleGroupItem value="generations" class="text-xs">Generations</ToggleGroupItem>
          <ToggleGroupItem value="downloads" class="text-xs">Downloads</ToggleGroupItem>
        </ToggleGroup>
        <ChartTypeToggle />
      </div>
    </div>

    <ToggleGroup
      type="multiple"
      value={selected}
      onValueChange={(v: string[]) => baseModelTrendSelection.set(v)}
      variant="outline"
      size="sm"
      spacing={1.5}
      class="mb-3 flex-wrap"
    >
      {#each universe as bm (bm)}
        {@const color = colorOf.get(bm)}
        <ToggleGroupItem value={bm} class="gap-1.5 text-xs">
          <span
            class="inline-block h-2 w-2 rounded-full"
            style="background:{color ?? 'transparent'};border:1px solid {color ?? '#4a4a4a'}"
          ></span>
          {ownSet.has(bm) ? `★ ${bm}` : bm}
        </ToggleGroupItem>
      {/each}
    </ToggleGroup>

    {#if shownTrends.length > 0}
      <div class="h-72">
        {#key chartType.value}
          <Chart type={chartType.value} data={trendData} options={trendOptions} class="h-full" />
        {/key}
      </div>
    {:else}
      <div class="flex h-40 items-center justify-center text-center text-sm text-dark-3">
        Pick one or more base models to compare.
      </div>
    {/if}
  </div>
{/if}

{#if data.baseModels && data.baseModels.length > 0}
  <div class="cs-panel p-4">
    <p class="text-sm font-medium text-white">Your base models</p>
    <p class="mb-3 text-xs text-dark-3">
      Your own generations, downloads &amp; earnings by base model {periodLabel} · click a column to sort
    </p>
    {#snippet sortHead(key: string, label: string)}
      {@const active = sortKey === key}
      <Table.Head class="text-right {active ? 'bg-dark-5/40' : ''}">
        <button
          type="button"
          onclick={() => setSortParam(key, sortKey, sortDir)}
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
    {#snippet pager()}
      <div class="flex flex-wrap items-center justify-between gap-2 text-xs text-dark-3">
        <span>{sorted.length} base models</span>
        <div class="flex items-center gap-3">
          <PageSizeSelect />
          {#if totalPages > 1}
            <div class="flex items-center gap-1">
              <button
                type="button"
                aria-label="Previous page"
                disabled={curPage <= 1}
                onclick={() => setPageParam(curPage - 1)}
                class="inline-flex cursor-pointer items-center rounded border border-dark-4 p-1 hover:text-white disabled:cursor-default disabled:opacity-40"
              >
                <IconChevronLeft size={13} />
              </button>
              {#each pageWindow(curPage, totalPages) as p, i (i)}
                {#if p === '…'}
                  <span class="px-1 text-dark-4">…</span>
                {:else}
                  <button
                    type="button"
                    onclick={() => setPageParam(p)}
                    class="min-w-6 cursor-pointer rounded border px-1.5 py-1 text-center {p === curPage
                      ? 'border-blue-8 bg-blue-8/20 text-white'
                      : 'border-dark-4 hover:text-white'}"
                  >
                    {p}
                  </button>
                {/if}
              {/each}
              <button
                type="button"
                aria-label="Next page"
                disabled={curPage >= totalPages}
                onclick={() => setPageParam(curPage + 1)}
                class="inline-flex cursor-pointer items-center rounded border border-dark-4 p-1 hover:text-white disabled:cursor-default disabled:opacity-40"
              >
                <IconChevronRight size={13} />
              </button>
            </div>
          {/if}
        </div>
      </div>
    {/snippet}
    <div class="mb-3">{@render pager()}</div>
    <Table.Root>
      <Table.Header>
        <Table.Row>
          <Table.Head>Base model</Table.Head>
          {@render sortHead('models', 'Models')}
          {@render sortHead('generations', 'Generations')}
          {@render sortHead('downloads', 'Downloads')}
          {#each currencies as c (c)}
            {@render sortHead(c, currencyMeta(c).label)}
          {/each}
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {#each pageRows as b (b.baseModel)}
          <Table.Row>
            <Table.Cell class="align-top text-dark-1">{b.baseModel}</Table.Cell>
            <Table.Cell class="align-top text-right tabular-nums text-dark-2">{num(b.modelCount)}</Table.Cell>
            <Table.Cell class="align-top text-right">
              <div class="tabular-nums {b.generations ? 'text-white' : 'text-dark-4'}">
                {b.generations ? num(b.generations) : '—'}
              </div>
              {#if b.generations}
                <div class="mt-0.5"><DeltaChip current={b.generations} previous={b.prevGenerations} /></div>
              {/if}
            </Table.Cell>
            <Table.Cell class="align-top text-right">
              <div class="tabular-nums {b.downloads ? 'text-white' : 'text-dark-4'}">
                {b.downloads ? num(b.downloads) : '—'}
              </div>
              {#if b.downloads}
                <div class="mt-0.5"><DeltaChip current={b.downloads} previous={b.prevDownloads} /></div>
              {/if}
            </Table.Cell>
            {#each currencies as c (c)}
              {@const cc = cell(b, c)}
              {@const show = hasDisplayValue(cc.total, c)}
              <Table.Cell class="align-top text-right">
                <div class="tabular-nums {show ? 'font-medium text-white' : 'text-dark-4'}">
                  {show ? formatAmount(cc.total, c) : '—'}
                </div>
                {#if show}
                  <div class="mt-0.5"><DeltaChip current={cc.total} previous={cc.prev} /></div>
                {/if}
              </Table.Cell>
            {/each}
          </Table.Row>
        {/each}
      </Table.Body>
    </Table.Root>

    {#if totalPages > 1}<div class="mt-3">{@render pager()}</div>{/if}
  </div>
{:else if data.baseModels === null}
  <div class="placeholder">Base-model performance is temporarily unavailable — please try again shortly.</div>
{:else}
  <div class="rounded-lg border border-dashed border-dark-4 p-4 text-sm text-dark-3">
    <strong class="text-dark-2">Your base models</strong> — no model activity {periodLabel} yet.
  </div>
{/if}
