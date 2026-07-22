<script lang="ts">
  import * as Table from '@civitai/ui/components/ui/table/index.js';
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
  import { formatRange } from '$lib/date-range';
  import { formatAmount, currencyMeta, currencySort, hasDisplayValue } from '$lib/earnings';
  import { analyticsPageSize } from '$lib/stores/analytics-page-size';
  import PageSizeSelect from '$lib/components/PageSizeSelect.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
  const num = (n: number) => n.toLocaleString();
  const periodLabel = $derived(`for ${formatRange(data.range)}`);
  const perPage = $derived($analyticsPageSize);

  const modelCurrencies = $derived(
    data.modelPerformance
      ? [...new Set(data.modelPerformance.flatMap((m) => m.currencies.map((c) => c.currency)))].sort(currencySort)
      : []
  );
  const modelCell = (m: NonNullable<PageData['modelPerformance']>[number], currency: string) =>
    m.currencies.find((c) => c.currency === currency)?.total ?? 0;
  const modelCellPrev = (m: NonNullable<PageData['modelPerformance']>[number], currency: string) =>
    m.currencies.find((c) => c.currency === currency)?.prev ?? 0;

  // Sort + page live in the URL (shallow routing) — sort replaces history, page pushes. Default: generations desc.
  const sortKey = $derived(page.url.searchParams.get('sort') ?? 'generations');
  const sortDir = $derived(page.url.searchParams.get('dir') === 'asc' ? 'asc' : 'desc');
  const pageNum = $derived(Math.max(1, Number(page.url.searchParams.get('page')) || 1));

  const sortValue = (m: NonNullable<PageData['modelPerformance']>[number], key: string): number =>
    key === 'generations' ? m.generations : key === 'downloads' ? m.downloads : modelCell(m, key);
  const sorted = $derived.by(() => {
    const rows = data.modelPerformance ? [...data.modelPerformance] : [];
    const dir = sortDir === 'desc' ? -1 : 1;
    return rows.sort((a, b) => dir * (sortValue(a, sortKey) - sortValue(b, sortKey)));
  });
  const totalPages = $derived(Math.max(1, Math.ceil(sorted.length / perPage)));
  const curPage = $derived(Math.min(pageNum, totalPages));
  const pageRows = $derived(sorted.slice((curPage - 1) * perPage, curPage * perPage));
</script>

{#if data.modelPerformance && data.modelPerformance.length > 0}
  <div class="rounded-lg border border-dark-4 bg-dark-6 p-4">
    <p class="mb-3 text-sm text-dark-2">
      Per-model performance <span class="text-xs text-dark-3">{periodLabel} · click a column to sort</span>
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
        <span>{sorted.length} models</span>
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
          <Table.Head>Model</Table.Head>
          {@render sortHead('generations', 'Generations')}
          {@render sortHead('downloads', 'Downloads')}
          {#each modelCurrencies as c (c)}
            {@render sortHead(c, currencyMeta(c).label)}
          {/each}
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {#each pageRows as m (m.modelVersionId)}
          <Table.Row>
            <Table.Cell class="max-w-55 align-top">
              {#if m.modelId}
                <a
                  href="/analytics/models/{m.modelId}"
                  class="group flex items-center gap-1 font-medium text-blue-4 hover:text-blue-3"
                  title="{m.modelName ?? `Model ${m.modelId}`}{m.versionName ? ` · ${m.versionName}` : ''}"
                >
                  <span class="min-w-0 truncate underline decoration-blue-4/40 underline-offset-2 group-hover:decoration-blue-3">
                    {m.modelName ?? `Model ${m.modelId}`}{#if m.versionName}<span class="text-dark-3"> · {m.versionName}</span>{/if}
                  </span>
                  <IconChevronRight size={14} class="shrink-0" />
                </a>
              {:else}
                <div class="truncate text-dark-2" title={m.versionName ?? ''}>
                  Version {m.modelVersionId}{#if m.versionName}<span class="text-dark-3"> · {m.versionName}</span>{/if}
                </div>
              {/if}
              <div class="truncate text-xs text-dark-3">{m.modelType ?? '—'}</div>
            </Table.Cell>
            <Table.Cell class="align-top text-right">
              <div class="tabular-nums {m.generations ? 'text-white' : 'text-dark-4'}">
                {m.generations ? num(m.generations) : '—'}
              </div>
              {#if m.generations}
                <div class="mt-0.5"><DeltaChip current={m.generations} previous={m.prevGenerations} /></div>
              {/if}
            </Table.Cell>
            <Table.Cell class="align-top text-right">
              <div class="tabular-nums {m.downloads ? 'text-white' : 'text-dark-4'}">
                {m.downloads ? num(m.downloads) : '—'}
              </div>
              {#if m.downloads}
                <div class="mt-0.5"><DeltaChip current={m.downloads} previous={m.prevDownloads} /></div>
              {/if}
            </Table.Cell>
            {#each modelCurrencies as c (c)}
              {@const v = modelCell(m, c)}
              {@const show = hasDisplayValue(v, c)}
              <Table.Cell class="align-top text-right">
                <div class="tabular-nums {show ? 'font-medium text-white' : 'text-dark-4'}">
                  {show ? formatAmount(v, c) : '—'}
                </div>
                {#if show}
                  <div class="mt-0.5"><DeltaChip current={v} previous={modelCellPrev(m, c)} /></div>
                {/if}
              </Table.Cell>
            {/each}
          </Table.Row>
        {/each}
      </Table.Body>
    </Table.Root>

    {#if totalPages > 1}<div class="mt-3">{@render pager()}</div>{/if}
  </div>
{:else if data.modelPerformance === null}
  <div class="placeholder">Per-model performance is temporarily unavailable — please try again shortly.</div>
{:else}
  <div class="rounded-lg border border-dashed border-dark-4 p-4 text-sm text-dark-3">
    <strong class="text-dark-2">Per-model performance</strong> — no model activity {periodLabel} yet.
  </div>
{/if}
