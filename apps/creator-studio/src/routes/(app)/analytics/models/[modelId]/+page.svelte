<script lang="ts">
  import * as Table from '@civitai/ui/components/ui/table/index.js';
  import { Chart } from '@civitai/ui/components/ui/chart/index.js';
  import { ToggleGroup, ToggleGroupItem } from '@civitai/ui/components/ui/toggle-group/index.js';
  import { chartType } from '$lib/stores/chart-type';
  import { analyticsMetric, type AnalyticsMetric } from '$lib/stores/analytics-metric';
  import ChartTypeToggle from '$lib/components/ChartTypeToggle.svelte';
  import {
    IconExternalLink,
    IconArrowLeft,
    IconArrowUp,
    IconArrowDown,
    IconArrowsSort,
  } from '@tabler/icons-svelte';
  import { tableSortState } from '$lib/state/table-sort.svelte';
  import DeltaChip from '$lib/components/DeltaChip.svelte';
  import CurrencyDisplay from '$lib/components/CurrencyDisplay.svelte';
  import { formatRange, eachDayIso, shiftIso, dayDiff } from '$lib/date-range';
  import { currencyMeta, currencySort, hasDisplayValue } from '$lib/earnings';
  import {
    BANKABLE_CURRENCIES,
    FILTERABLE_CURRENCIES,
    currencySelectionKind,
  } from '$lib/buzz-currency-filter';
  import { buzzCurrencyState } from '$lib/state/buzz-currency.svelte';
  import { modelUrl } from '$lib/model-url';
  import AnalyticsHeader from '$lib/components/AnalyticsHeader.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
  const num = (n: number) => n.toLocaleString();
  const periodLabel = $derived(`for ${formatRange(data.range)}`);

  const versions = $derived(data.model.versions);

  // Sort keys match /analytics/models exactly (`channel:*`, `cash:*`) so one remembered choice applies to
  // both tables. `baseModel` is this table's own column and simply doesn't exist there — an unknown key
  // falls through to generations rather than producing an empty comparator.
  const sorting = tableSortState('models', () => data.tableSort, {
    sort: 'generations',
    dir: 'desc',
  });
  const sortKey = $derived(sorting.key);
  const sortDir = $derived(sorting.dir);
  const sortValue = (v: VersionRow, key: string): number =>
    key === 'downloads'
      ? v.downloads
      : key.startsWith('channel:')
        ? channelTotal(v, key.slice('channel:'.length) as (typeof CHANNELS)[number])
        : key.startsWith('cash:')
          ? cell(v, key.slice('cash:'.length)).total
          : v.generations;
  // The chart reads `versions` in its own order; only the table is sorted.
  const sortedVersions = $derived.by(() => {
    if (sortKey === 'baseModel')
      return [...versions].sort(
        (a, b) =>
          (sortDir === 'desc' ? -1 : 1) * (a.baseModel ?? '').localeCompare(b.baseModel ?? '')
      );
    const dir = sortDir === 'desc' ? -1 : 1;
    return [...versions].sort((a, b) => dir * (sortValue(a, sortKey) - sortValue(b, sortKey)));
  });

  // Version-comparison overlay (868ke493d) — pick versions and overlay one metric (generations or downloads) across
  // them over the range. Defaults to the most active versions, but any version (incl. zero-activity) can be toggled on.
  const VERSION_COLORS = [
    '#4dabf7',
    '#f783ac',
    '#ffa94d',
    '#69db7c',
    '#a78bfa',
    '#63e6be',
    '#ff8787',
    '#ffd43b',
    '#4dd4c4',
    '#e599f7',
  ];
  const metricLabel = { generations: 'Generations', downloads: 'Downloads' } as const;
  const seriesVersions = $derived(data.series?.versions ?? []);
  // Default: the top 5 versions that actually have activity (gen + downloads) over the period, so the chart doesn't
  // open on a pile of flat-zero lines. Any version (incl. zero-activity) can still be toggled on. Reseed when the
  // model/range (and thus the version set) changes.
  let selectedVersionIds = $state<number[]>([]);
  $effect(() => {
    selectedVersionIds = [...seriesVersions]
      .filter((v) => v.totalGenerations + v.totalDownloads > 0)
      .sort(
        (a, b) => b.totalGenerations + b.totalDownloads - (a.totalGenerations + a.totalDownloads)
      )
      .slice(0, 5)
      .map((v) => v.versionId);
  });
  const mmdd = (d: string) => (d.length >= 10 ? d.slice(5, 10) : d);
  const pickedVersions = $derived(
    seriesVersions.filter((v) => selectedVersionIds.includes(v.versionId))
  );
  // Color is keyed to a version's position among the *picked* set, so a chip's dot always matches its line.
  const colorByVersion = $derived(
    new Map(pickedVersions.map((v, i) => [v.versionId, VERSION_COLORS[i % VERSION_COLORS.length]]))
  );
  // Comparison-month series, per version, for the dashed overlay (mirrors /analytics/base-models).
  const compareByVersion = $derived(
    new Map((data.compareSeries?.versions ?? []).map((v) => [v.versionId, v]))
  );
  const compareDelta = $derived(dayDiff(data.range.from, data.compare.from));
  const compareData = $derived.by(() => {
    // Full month on the x-axis; the current line stops at `through`, the comparison line at its own month end.
    const dates = eachDayIso(data.range);
    const current = pickedVersions.map((v) => {
      const byDate = new Map(v.points.map((p) => [p.date, p[analyticsMetric.value]]));
      const color = colorByVersion.get(v.versionId);
      return {
        label: v.versionName ?? `Version ${v.versionId}`,
        data: dates.map((d) => (d <= data.through ? (byDate.get(d) ?? 0) : null)),
        borderColor: color,
        backgroundColor: color,
        tension: 0.3,
        fill: false,
        pointRadius: dates.length > 45 ? 0 : 2,
        order: 1,
      };
    });
    // Same colour, dimmed + dashed, aligned day-for-day under the current month.
    const compare = pickedVersions.map((v) => {
      const color = colorByVersion.get(v.versionId) ?? '#868e96';
      const byDate = new Map(
        (compareByVersion.get(v.versionId)?.points ?? []).map((p) => [
          p.date,
          p[analyticsMetric.value],
        ])
      );
      return {
        type: 'line' as const,
        label: `${v.versionName ?? `Version ${v.versionId}`} (${data.compare.label})`,
        data: dates.map((d) => {
          const cd = shiftIso(d, compareDelta);
          return cd <= data.compare.to ? (byDate.get(cd) ?? 0) : null;
        }),
        borderColor: `${color}80`,
        backgroundColor: `${color}80`,
        borderDash: [4, 4],
        borderWidth: 1.25,
        tension: 0.3,
        fill: false,
        pointRadius: 0,
        order: 0,
      };
    });
    return { labels: dates.map(mmdd), datasets: [...current, ...compare] };
  });
  const compareHasData = $derived(pickedVersions.length > 0);
  // Legend shows only the solid current lines — the dashed comparison twins would just double every entry.
  const compareOptions = $derived({
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
          filter: (item: { datasetIndex?: number }) =>
            (item.datasetIndex ?? 0) < pickedVersions.length,
        },
      },
    },
    scales: { x: { ticks: { maxTicksLimit: 8, autoSkip: true } }, y: { beginAtZero: true } },
  });
  type VersionRow = PageData['model']['versions'][number];

  const CHANNELS = [
    'licenseFee',
    'compensation',
    'earlyAccess',
    'permanentAccess',
    'donation',
  ] as const;
  const CHANNEL_HEAD: Record<(typeof CHANNELS)[number], string> = {
    licenseFee: 'License Fees',
    compensation: 'Compensation',
    earlyAccess: 'Early Access',
    permanentAccess: 'Perm. Access',
    donation: 'Donations',
  };

  const currencies = buzzCurrencyState(() => data.buzzCurrencies);
  const selected = $derived(currencies.value);
  const selectedSet = $derived(new Set<string>(selected));
  const selectionKind = $derived(currencySelectionKind(selected));
  const selectionLabel = $derived(
    selectionKind === 'bankable'
      ? 'Withdrawable buzz'
      : selectionKind === 'all'
        ? 'All buzz'
        : selected.map((c: string) => currencyMeta(c).label).join(' + ')
  );

  const channelTotal = (v: VersionRow, c: (typeof CHANNELS)[number]) =>
    v.channels[c].received.reduce(
      (sum, r) => (selectedSet.has(r.currency) ? sum + r.total : sum),
      0
    );
  const channelPrev = (v: VersionRow, c: (typeof CHANNELS)[number]) =>
    v.channels[c].received.reduce(
      (sum, r) => (selectedSet.has(r.currency) ? sum + r.prev : sum),
      0
    );

  // Cash settles separately and is never summed with buzz, so it keeps its own columns and ignores the
  // toggles entirely.
  const cashCurrencies = $derived(
    [
      ...new Set(
        versions.flatMap((v) =>
          v.currencies
            .filter((c) => currencyMeta(c.currency).family === 'cash')
            .map((c) => c.currency)
        )
      ),
    ].sort(currencySort)
  );
  const cell = (v: VersionRow, currency: string) =>
    v.currencies.find((c) => c.currency === currency) ?? { currency, total: 0, prev: 0 };

  const civitaiUrl = $derived(modelUrl(data.model.modelId, data.model));
</script>

<AnalyticsHeader range={data.range} compare={data.compare} />

<div class="mb-4 flex flex-wrap items-start gap-3">
  <div>
    <a
      href="/analytics/models"
      class="mb-1 inline-flex items-center gap-1 text-xs text-dark-2 hover:text-white"
    >
      <IconArrowLeft size={13} /> All models
    </a>
    <h2 class="flex items-center gap-2 text-xl font-semibold text-white">
      {data.model.modelName ?? `Model ${data.model.modelId}`}
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
    <p class="text-sm text-dark-3">Per-version performance {periodLabel}.</p>
  </div>
</div>

{#if seriesVersions.length > 0}
  <div class="mb-4 cs-panel p-4">
    <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
      <p class="text-sm font-medium text-white">
        Compare versions
        <span class="text-xs text-dark-3">
          · {metricLabel[analyticsMetric.value].toLowerCase()} over time {periodLabel}
          · dashed = {data.compare.label}
        </span>
      </p>
      <div class="flex flex-wrap items-center gap-2">
        <ToggleGroup
          type="single"
          value={analyticsMetric.value}
          onValueChange={(v: string) => {
            if (v) analyticsMetric.set(v as AnalyticsMetric);
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
      value={selectedVersionIds.map(String)}
      onValueChange={(v: string[]) => {
        selectedVersionIds = v.map(Number);
      }}
      variant="outline"
      size="sm"
      spacing={1.5}
      class="mb-3 flex-wrap"
    >
      {#each seriesVersions as v (v.versionId)}
        {@const color = colorByVersion.get(v.versionId)}
        <ToggleGroupItem value={String(v.versionId)} class="gap-1.5 text-xs">
          <span
            class="inline-block h-2 w-2 rounded-full"
            style="background:{color ?? 'transparent'};border:1px solid {color ?? '#4a4a4a'}"
          ></span>
          {v.versionName ?? `Version ${v.versionId}`}
        </ToggleGroupItem>
      {/each}
    </ToggleGroup>

    {#if compareHasData}
      <div class="h-72">
        {#key chartType.value}
          <Chart
            type={chartType.value}
            data={compareData}
            options={compareOptions}
            class="h-full"
          />
        {/key}
      </div>
    {:else}
      <div class="flex h-40 items-center justify-center text-center text-sm text-dark-3">
        {selectedVersionIds.length === 0
          ? 'Pick one or more versions to compare.'
          : 'No generations or downloads for the selected versions in this period.'}
      </div>
    {/if}
  </div>
{/if}

{#if versions.length === 0}
  <div class="placeholder">This model has no versions.</div>
{:else}
  <div class="cs-panel p-4">
    <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
      <span class="rounded bg-dark-5 px-1.5 py-0.5 text-xs text-dark-2">{selectionLabel}</span>
      <div class="flex items-center gap-2">
        <span class="text-xs text-dark-3">Counting</span>
        <ToggleGroup
          type="multiple"
          variant="outline"
          size="sm"
          spacing={1}
          value={[...selected]}
          onValueChange={(v: string[]) => currencies.set(v)}
          aria-label="Which buzz types the earnings columns count"
        >
          {#each FILTERABLE_CURRENCIES as c (c)}
            {@const withdrawable = (BANKABLE_CURRENCIES as readonly string[]).includes(c)}
            <ToggleGroupItem
              value={c}
              title="{currencyMeta(c).label} — {withdrawable
                ? 'can be withdrawn'
                : 'cannot be withdrawn'}"
              class="gap-1.5 text-xs"
            >
              <span class="size-2 shrink-0 rounded-full" style="background:{currencyMeta(c).color}"
              ></span>
              {currencyMeta(c).label}
            </ToggleGroupItem>
          {/each}
        </ToggleGroup>
      </div>
    </div>
    {#snippet sortHead(key: string, label: string, extra = '')}
      {@const active = sortKey === key}
      <Table.Head class="p-0 {extra}">
        <button
          type="button"
          onclick={() => sorting.toggle(key)}
          class="flex h-10 w-full cursor-pointer items-center justify-end gap-1 px-2 hover:text-white {active
            ? 'bg-dark-5/40 font-medium text-white'
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
          <Table.Head>Version</Table.Head>
          {@render sortHead('baseModel', 'Base model')}
          {@render sortHead('generations', 'Generations')}
          {@render sortHead('downloads', 'Downloads')}
          {#each CHANNELS as c (c)}
            {@render sortHead('channel:' + c, CHANNEL_HEAD[c])}
          {/each}
          {#each cashCurrencies as c (c)}
            {@render sortHead('cash:' + c, currencyMeta(c).label, 'border-l border-dark-4')}
          {/each}
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {#each sortedVersions as v (v.versionId)}
          <Table.Row>
            <Table.Cell class="align-top text-dark-1"
              >{v.versionName ?? `Version ${v.versionId}`}</Table.Cell
            >
            <Table.Cell class="align-top text-dark-2">{v.baseModel ?? '—'}</Table.Cell>
            <Table.Cell class="align-top text-right">
              <div class="tabular-nums {v.generations ? 'text-white' : 'text-dark-4'}">
                {v.generations ? num(v.generations) : '—'}
              </div>
              {#if v.generations}
                <div class="mt-0.5">
                  <DeltaChip current={v.generations} previous={v.prevGenerations} />
                </div>
              {/if}
            </Table.Cell>
            <Table.Cell class="align-top text-right">
              <div class="tabular-nums {v.downloads ? 'text-white' : 'text-dark-4'}">
                {v.downloads ? num(v.downloads) : '—'}
              </div>
              {#if v.downloads}
                <div class="mt-0.5">
                  <DeltaChip current={v.downloads} previous={v.prevDownloads} />
                </div>
              {/if}
            </Table.Cell>
            {#each CHANNELS as c (c)}
              {@const total = channelTotal(v, c)}
              {@const show = hasDisplayValue(total, 'yellow')}
              <Table.Cell class="align-top text-right">
                <div class="tabular-nums {show ? 'font-medium text-white' : 'text-dark-4'}">
                  {#if show}<CurrencyDisplay amount={total} />{:else}—{/if}
                </div>
                {#if show}
                  <div class="mt-0.5">
                    <DeltaChip current={total} previous={channelPrev(v, c)} />
                  </div>
                {/if}
              </Table.Cell>
            {/each}
            {#each cashCurrencies as c (c)}
              {@const cc = cell(v, c)}
              {@const show = hasDisplayValue(cc.total, c)}
              <Table.Cell class="border-l border-dark-4 align-top text-right">
                <div class="tabular-nums {show ? 'font-medium text-white' : 'text-dark-4'}">
                  {#if show}<CurrencyDisplay amount={cc.total} currency={c} />{:else}—{/if}
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
  </div>
{/if}
