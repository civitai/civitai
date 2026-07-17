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
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
  const num = (n: number) => n.toLocaleString();
  const periodLabel = $derived(`for ${formatRange(data.range)}`);
  const PER_PAGE = 25;

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
  const totalPages = $derived(Math.max(1, Math.ceil(sorted.length / PER_PAGE)));
  const curPage = $derived(Math.min(pageNum, totalPages));
  const pageRows = $derived(sorted.slice((curPage - 1) * PER_PAGE, curPage * PER_PAGE));
</script>

{#if data.baseModels && data.baseModels.length > 0}
  <div class="rounded-lg border border-dark-4 bg-dark-6 p-4">
    <p class="mb-3 text-sm text-dark-2">
      Performance by base model <span class="text-xs text-dark-3">{periodLabel} · click a column to sort</span>
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
      </div>
    {/snippet}
    {#if totalPages > 1}<div class="mb-3">{@render pager()}</div>{/if}
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
    <strong class="text-dark-2">Base models</strong> — no model activity {periodLabel} yet.
  </div>
{/if}
