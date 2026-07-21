<script lang="ts">
  import { goto } from '$app/navigation';
  import * as Table from '@civitai/ui/components/ui/table/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Chart } from '@civitai/ui/components/ui/chart/index.js';
  import { ToggleGroup, ToggleGroupItem } from '@civitai/ui/components/ui/toggle-group/index.js';
  import { IconExternalLink, IconArrowLeft } from '@tabler/icons-svelte';
  import DeltaChip from '$lib/components/DeltaChip.svelte';
  import { formatRange } from '$lib/date-range';
  import { formatAmount, currencyMeta, currencySort, hasDisplayValue } from '$lib/earnings';
  import { modelUrl } from '$lib/model-url';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
  const num = (n: number) => n.toLocaleString();
  const periodLabel = $derived(`for ${formatRange(data.range)}`);

  const versions = $derived(data.model.versions);

  // Version-comparison overlay (868ke493d) — pick versions and overlay one metric (generations or downloads) across
  // them over the range. Defaults to the most active versions, but any version (incl. zero-activity) can be toggled on.
  const VERSION_COLORS = [
    '#4dabf7', '#f783ac', '#ffa94d', '#69db7c', '#a78bfa', '#63e6be', '#ff8787', '#ffd43b', '#4dd4c4', '#e599f7',
  ];
  const metricLabel = { generations: 'Generations', downloads: 'Downloads' } as const;
  const seriesVersions = $derived(data.series?.versions ?? []);
  let metric = $state<'generations' | 'downloads'>('generations');
  // Default: the top 5 versions by total activity (gen + downloads) over the period. Reseed when the model/range
  // (and thus the version set) changes.
  let selectedVersionIds = $state<number[]>([]);
  $effect(() => {
    selectedVersionIds = [...seriesVersions]
      .sort((a, b) => b.totalGenerations + b.totalDownloads - (a.totalGenerations + a.totalDownloads))
      .slice(0, 5)
      .map((v) => v.versionId);
  });
  // Color is keyed to a version's position among the *picked* set, so a chip's dot always matches its line.
  const colorByVersion = $derived.by(() => {
    const picked = seriesVersions.filter((v) => selectedVersionIds.includes(v.versionId));
    return new Map(picked.map((v, i) => [v.versionId, VERSION_COLORS[i % VERSION_COLORS.length]]));
  });
  const compareData = $derived.by(() => {
    const picked = seriesVersions.filter((v) => selectedVersionIds.includes(v.versionId));
    const dates = [...new Set(picked.flatMap((v) => v.points.map((p) => p.date)))].sort();
    return {
      labels: dates,
      datasets: picked.map((v) => {
        const byDate = new Map(v.points.map((p) => [p.date, p[metric]]));
        const color = colorByVersion.get(v.versionId);
        return {
          label: v.versionName ?? `Version ${v.versionId}`,
          data: dates.map((d) => byDate.get(d) ?? 0),
          borderColor: color,
          backgroundColor: color,
          tension: 0.3,
          fill: false,
          pointRadius: dates.length > 45 ? 0 : 2,
        };
      }),
    };
  });
  const compareHasData = $derived(compareData.labels.length > 0 && compareData.datasets.length > 0);
  const compareOptions = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index' as const, intersect: false },
    plugins: {
      legend: { display: true, position: 'bottom' as const, labels: { boxWidth: 12, font: { size: 11 } } },
    },
    scales: { x: { ticks: { maxTicksLimit: 8, autoSkip: true } }, y: { beginAtZero: true } },
  };
  const currencies = $derived(
    [...new Set(versions.flatMap((v) => v.currencies.map((c) => c.currency)))].sort(currencySort)
  );
  const cell = (v: PageData['model']['versions'][number], currency: string) =>
    v.currencies.find((c) => c.currency === currency) ?? { currency, total: 0, prev: 0 };

  const civitaiUrl = $derived(modelUrl(data.model.modelId, data.model));

  let lookupId = $state('');
  function goToModel(e: Event) {
    e.preventDefault();
    const id = Number(lookupId);
    if (Number.isInteger(id) && id > 0) goto(`/analytics/models/${id}`);
  }
</script>

<div class="mb-4 flex flex-wrap items-start gap-3">
  <div>
    <a href="/analytics/models" class="mb-1 inline-flex items-center gap-1 text-xs text-dark-2 hover:text-white">
      <IconArrowLeft size={13} /> All models
    </a>
    <h2 class="flex items-center gap-2 text-xl font-semibold text-white">
      {data.model.modelName ?? `Model ${data.model.modelId}`}
      <a href={civitaiUrl} target="_blank" rel="noreferrer" class="text-dark-3 hover:text-white" aria-label="View on Civitai">
        <IconExternalLink size={16} />
      </a>
    </h2>
    <p class="text-sm text-dark-3">Per-version performance {periodLabel}.</p>
  </div>
  <form onsubmit={goToModel} class="ml-auto flex items-center gap-1">
    <input
      type="text"
      inputmode="numeric"
      bind:value={lookupId}
      placeholder="Model ID"
      class="w-24 rounded-lg border border-dark-4 bg-dark-6 px-2.5 py-1 text-sm text-white placeholder:text-dark-3"
    />
    <Button type="submit" size="sm" variant="secondary">View</Button>
  </form>
</div>

{#if seriesVersions.length > 0}
  <div class="mb-4 rounded-lg border border-dark-4 bg-dark-6 p-4">
    <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
      <p class="text-sm text-dark-2">
        Compare versions
        <span class="text-xs text-dark-3">· {metricLabel[metric].toLowerCase()} over time {periodLabel}</span>
      </p>
      <ToggleGroup
        type="single"
        value={metric}
        onValueChange={(v: string) => {
          if (v) metric = v as 'generations' | 'downloads';
        }}
        variant="outline"
        size="sm"
      >
        <ToggleGroupItem value="generations" class="text-xs">Generations</ToggleGroupItem>
        <ToggleGroupItem value="downloads" class="text-xs">Downloads</ToggleGroupItem>
      </ToggleGroup>
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
        <Chart type="line" data={compareData} options={compareOptions} class="h-full" />
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
  <div class="rounded-lg border border-dark-4 bg-dark-6 p-4">
    <Table.Root>
      <Table.Header>
        <Table.Row>
          <Table.Head>Version</Table.Head>
          <Table.Head>Base model</Table.Head>
          <Table.Head class="text-right">Generations</Table.Head>
          <Table.Head class="text-right">Downloads</Table.Head>
          {#each currencies as c (c)}
            <Table.Head class="text-right">{currencyMeta(c).label}</Table.Head>
          {/each}
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {#each versions as v (v.versionId)}
          <Table.Row>
            <Table.Cell class="align-top text-dark-1">{v.versionName ?? `Version ${v.versionId}`}</Table.Cell>
            <Table.Cell class="align-top text-dark-2">{v.baseModel ?? '—'}</Table.Cell>
            <Table.Cell class="align-top text-right">
              <div class="tabular-nums {v.generations ? 'text-white' : 'text-dark-4'}">
                {v.generations ? num(v.generations) : '—'}
              </div>
              {#if v.generations}
                <div class="mt-0.5"><DeltaChip current={v.generations} previous={v.prevGenerations} /></div>
              {/if}
            </Table.Cell>
            <Table.Cell class="align-top text-right">
              <div class="tabular-nums {v.downloads ? 'text-white' : 'text-dark-4'}">
                {v.downloads ? num(v.downloads) : '—'}
              </div>
              {#if v.downloads}
                <div class="mt-0.5"><DeltaChip current={v.downloads} previous={v.prevDownloads} /></div>
              {/if}
            </Table.Cell>
            {#each currencies as c (c)}
              {@const cc = cell(v, c)}
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
  </div>
{/if}
