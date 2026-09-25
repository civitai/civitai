<script lang="ts">
  import * as Table from '@civitai/ui/components/ui/table/index.js';
  import { Chart, chartColor } from '@civitai/ui/components/ui/chart/index.js';
  import {
    IconArrowUp,
    IconArrowDown,
    IconArrowsSort,
    IconDatabase,
    IconEyeOff,
    IconExternalLink,
    IconLoader2,
  } from '@tabler/icons-svelte';
  import { page } from '$app/state';
  import AnalyticsHeader from '$lib/components/AnalyticsHeader.svelte';
  import StatCard from '$lib/components/StatCard.svelte';
  import Pagination from '$lib/components/Pagination.svelte';
  import { tableSortState } from '$lib/state/table-sort.svelte';
  import { analyticsPageSize } from '$lib/stores/analytics-page-size';
  import { modelUrl } from '$lib/model-url';
  import {
    MODEL_STATUS_LABELS,
    STORAGE_KIND_LABELS,
    formatBytes,
    kindRank,
    storageEmptyKind,
  } from '$lib/analytics/storage';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
  const num = (n: number) => n.toLocaleString();

  const summary = $derived(data.summary);
  const media = $derived(summary ? data.media : null);
  const hasModelTable = $derived(!!data.byModel?.length);
  const emptyKind = $derived(
    summary ? storageEmptyKind(summary, data.byModel ? data.byModel.length : null) : null
  );
  const totalModels = $derived(data.byModel?.[0]?.totalModels ?? 0);

  const kindColor = (kind: string) => chartColor(kindRank(kind));
  const bytesLabel = (ctx: { raw: unknown }) => formatBytes(Number(ctx.raw));

  const doughnutData = $derived({
    labels: summary?.byKind.map((k) => k.label) ?? [],
    datasets: [
      {
        data: summary?.byKind.map((k) => k.bytes) ?? [],
        backgroundColor: summary?.byKind.map((k) => kindColor(k.kind)) ?? [],
        borderWidth: 0,
      },
    ],
  });
  const doughnutOptions = {
    responsive: true,
    maintainAspectRatio: false,
    cutout: '58%',
    plugins: {
      legend: { display: false },
      tooltip: { callbacks: { label: bytesLabel } },
    },
  };

  const baseRows = $derived([
    ...(summary?.baseModels ?? []),
    ...(summary?.otherBaseModels
      ? [{ baseModel: 'All other base models', ...summary.otherBaseModels }]
      : []),
  ]);
  const baseData = $derived({
    labels: baseRows.map((b) => b.baseModel),
    datasets: [
      {
        label: 'Model files',
        data: baseRows.map((b) => b.bytes),
        backgroundColor: kindColor('model'),
        borderRadius: 3,
      },
    ],
  });
  const bytesTick = { callback: (v: string | number) => formatBytes(Number(v)) };
  const baseOptions = {
    indexAxis: 'y' as const,
    responsive: true,
    maintainAspectRatio: false,
    scales: { x: { beginAtZero: true, ticks: bytesTick } },
    plugins: {
      legend: { display: false },
      tooltip: { callbacks: { label: bytesLabel } },
    },
  };

  const monthData = $derived({
    labels: summary?.months.map((m) => m.month.slice(0, 7)) ?? [],
    datasets: (summary?.kinds ?? []).map((kind) => ({
      label: STORAGE_KIND_LABELS[kind] ?? kind,
      data: summary?.months.map((m) => m.bytesByKind[kind] ?? 0) ?? [],
      backgroundColor: kindColor(kind),
    })),
  });
  const monthOptions = {
    responsive: true,
    maintainAspectRatio: false,
    scales: {
      x: { stacked: true, ticks: { maxTicksLimit: 12, autoSkip: true, maxRotation: 0 } },
      y: { stacked: true, beginAtZero: true, ticks: bytesTick },
    },
    plugins: {
      tooltip: {
        callbacks: {
          label: (ctx: { dataset: { label?: string }; raw: unknown }) =>
            `${ctx.dataset.label}: ${formatBytes(Number(ctx.raw))}`,
        },
      },
    },
  };

  const perPage = $derived(analyticsPageSize.value);
  const sorting = tableSortState('storage', () => data.tableSort, { sort: 'bytes', dir: 'desc' });
  const sortKey = $derived(sorting.key);
  const sortDir = $derived(sorting.dir);
  const pageNum = $derived(Math.max(1, Number(page.url.searchParams.get('page')) || 1));
  type ModelRow = NonNullable<PageData['byModel']>[number];
  const sortValue = (m: ModelRow, key: string) =>
    key === 'files' ? m.files : key === 'versions' ? m.versions : m.bytes;
  const sorted = $derived.by(() => {
    const dir = sortDir === 'desc' ? -1 : 1;
    return [...(data.byModel ?? [])].sort(
      (a, b) => dir * (sortValue(a, sortKey) - sortValue(b, sortKey))
    );
  });
  const totalPages = $derived(Math.max(1, Math.ceil(sorted.length / perPage)));
  const curPage = $derived(Math.min(pageNum, totalPages));
  const pageRows = $derived(sorted.slice((curPage - 1) * perPage, curPage * perPage));

  const baseSummary = $derived(
    baseRows.map((b) => `${b.baseModel} ${formatBytes(b.bytes)}`).join(', ')
  );
  const monthSummary = $derived(
    (summary?.months ?? [])
      .slice(-12)
      .map(
        (m) =>
          `${m.month.slice(0, 7)} ${formatBytes(Object.values(m.bytesByKind).reduce((a, b) => a + b, 0))}`
      )
      .join(', ')
  );
</script>

<AnalyticsHeader />

<p class="mb-4 text-sm text-dark-2">
  What you've uploaded to Civitai and still have here. It is the size of the files you uploaded, not
  what they cost to store or serve.
</p>

<!-- The overnight notice already explains an empty rollup; the banner on top of it would contradict it. -->
{#if media && media !== 'done' && emptyKind !== 'overnight'}
  <div
    class="mb-4 flex items-center gap-2 rounded-lg border border-dashed border-dark-4 p-3 text-sm text-dark-2"
    role="status"
  >
    <IconLoader2 size={16} class="animate-spin text-blue-4" aria-hidden="true" />
    {#if media === 'first'}
      Counting your images and videos for the first time. This can take a few minutes, and until
      then they aren't included.
    {:else if media === 'refreshing'}
      Updating your images and videos. Until it's done they show as of your last count.
    {:else}
      Counting your images and videos is taking longer than expected, so they may be missing or out
      of date. We'll keep trying.
    {/if}
  </div>
{/if}

{#if data.ready === false}
  <div class="placeholder">Storage usage isn't available yet. Please check back soon.</div>
{:else if summary === null}
  <div class="placeholder">Storage is temporarily unavailable. Please try again shortly.</div>
{:else if emptyKind === 'overnight'}
  <div class="rounded-lg border border-dashed border-dark-4 p-4 text-sm text-dark-2">
    <strong class="text-white">Your totals update overnight.</strong> New uploads show up here by
    tomorrow.
    {#if hasModelTable}Your models are listed below in the meantime.{/if}
  </div>
{:else if emptyKind === 'none' && media !== 'done'}
  <!-- The banner above already says what is happening; 0 B cards would only contradict it. -->
{:else if emptyKind === 'none'}
  <div class="rounded-lg border border-dashed border-dark-4 p-4 text-sm text-dark-2">
    <strong class="text-white">Nothing here yet.</strong> Once you upload models, images or videos, their
    size shows up here.
  </div>
{:else}
  <div class="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
    <StatCard label="Total uploaded" icon={IconDatabase} color="#4dabf7">
      <p class="mt-1 text-xl font-semibold text-white">{formatBytes(summary.total.bytes)}</p>
      <p class="mt-2 text-xs text-dark-2">{num(summary.total.fileCount)} files, public only</p>
    </StatCard>
    {#each summary.byKind as k (k.kind)}
      <StatCard label={k.label} color={kindColor(k.kind)}>
        <p class="mt-1 text-xl font-semibold text-white">{formatBytes(k.bytes)}</p>
        <p class="mt-2 text-xs text-dark-2">{num(k.fileCount)} files</p>
      </StatCard>
    {/each}
    <StatCard label="Not public" icon={IconEyeOff} color="#868e96">
      <p class="mt-1 text-xl font-semibold text-white">{formatBytes(summary.notPublic.bytes)}</p>
      <p class="mt-2 text-xs text-dark-2">Drafts, unpublished and removed. Not in the total.</p>
    </StatCard>
  </div>

  {#if summary.byKind.length > 0}
    <div class="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
      <div class="cs-panel p-4">
        <p class="mb-3 text-sm font-medium text-white">By type</p>
        <div class="grid grid-cols-1 items-center gap-4 sm:grid-cols-[12rem_1fr]">
          <div class="h-48" aria-hidden="true">
            <Chart type="doughnut" data={doughnutData} options={doughnutOptions} class="h-full" />
          </div>
          <dl class="grid grid-cols-1 gap-2">
            {#each summary.byKind as k (k.kind)}
              <div class="flex items-baseline justify-between gap-3">
                <dt class="flex items-center gap-2 text-sm text-dark-1">
                  <span class="size-2 shrink-0 rounded-full" style="background: {kindColor(k.kind)}"
                  ></span>
                  {k.label}
                </dt>
                <dd class="whitespace-nowrap text-sm text-white">{formatBytes(k.bytes)}</dd>
              </div>
            {/each}
          </dl>
        </div>
      </div>

      {#if baseRows.length > 0}
        <div class="cs-panel p-4">
          <p class="mb-3 text-sm font-medium text-white">
            Model files by base model <span class="text-xs text-dark-2">· top 10</span>
          </p>
          <div class="h-64" role="img" aria-label="Model files by base model: {baseSummary}">
            <Chart type="bar" data={baseData} options={baseOptions} class="h-full" />
          </div>
        </div>
      {/if}
    </div>

    <div class="cs-panel mt-4 p-4">
      <p class="mb-3 text-sm font-medium text-white">
        Uploaded per month <span class="text-xs text-dark-2"
          >· content that's still on Civitai, by when you uploaded it</span
        >
      </p>
      <div class="h-64" role="img" aria-label="Uploaded per month: {monthSummary}">
        <Chart type="bar" data={monthData} options={monthOptions} class="h-full" />
      </div>
    </div>
  {/if}
{/if}

{#if data.byModel && data.byModel.length > 0}
  <div class="cs-panel mt-4 p-4">
    <p class="mb-3 text-sm font-medium text-white">
      By model <span class="text-xs text-dark-2"
        >· every file on the model, training data included · click a column to sort</span
      >
    </p>

    {#snippet sortHead(key: string, label: string)}
      {@const active = sortKey === key}
      <Table.Head
        class="text-right {active ? 'bg-dark-5/40' : ''}"
        aria-sort={active ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
      >
        <button
          type="button"
          onclick={() => sorting.toggle(key)}
          class="flex w-full cursor-pointer items-center justify-end gap-1 hover:text-white {active
            ? 'font-medium text-white'
            : 'text-dark-2'}"
        >
          <span>{label}</span>
          {#if active}
            {#if sortDir === 'asc'}<IconArrowUp
                size={14}
                class="text-blue-4"
              />{:else}<IconArrowDown size={14} class="text-blue-4" />{/if}
          {:else}
            <IconArrowsSort size={14} class="text-dark-4" />
          {/if}
        </button>
      </Table.Head>
    {/snippet}

    {#if totalModels > sorted.length}
      <p class="mb-2 text-xs text-dark-2">
        Showing your {num(sorted.length)} largest models of {num(totalModels)}. Sorting applies to
        these.
      </p>
    {/if}
    <div class="mb-3">
      <Pagination total={sorted.length} noun="model" {curPage} {totalPages} />
    </div>
    <Table.Root>
      <Table.Header>
        <Table.Row>
          <Table.Head>Model</Table.Head>
          <Table.Head>Status</Table.Head>
          {@render sortHead('versions', 'Versions')}
          {@render sortHead('files', 'Files')}
          {@render sortHead('bytes', 'Size')}
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {#each pageRows as m (m.modelId)}
          <Table.Row>
            <Table.Cell>
              <a
                href={modelUrl(m.modelId, m)}
                target="_blank"
                rel="noreferrer"
                class="flex max-w-80 items-center gap-1 text-dark-1 hover:text-white hover:underline"
                title={m.name}
              >
                <span class="block min-w-0 flex-1 truncate">{m.name}</span>
                <IconExternalLink size={13} class="shrink-0 text-dark-3" />
              </a>
            </Table.Cell>
            <Table.Cell class="text-dark-2">{MODEL_STATUS_LABELS[m.status] ?? m.status}</Table.Cell>
            <Table.Cell class="text-right tabular-nums">{num(m.versions)}</Table.Cell>
            <Table.Cell class="text-right tabular-nums">{num(m.files)}</Table.Cell>
            <Table.Cell class="text-right font-medium tabular-nums text-white"
              >{formatBytes(m.bytes)}</Table.Cell
            >
          </Table.Row>
        {/each}
      </Table.Body>
    </Table.Root>
    {#if totalPages > 1}
      <div class="mt-3">
        <Pagination total={sorted.length} noun="model" {curPage} {totalPages} />
      </div>
    {/if}
  </div>
{/if}
