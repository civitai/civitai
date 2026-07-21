<script lang="ts">
  import * as Table from '@civitai/ui/components/ui/table/index.js';
  import {
    IconArrowUp,
    IconArrowDown,
    IconArrowsSort,
    IconChevronLeft,
    IconChevronRight,
    IconExternalLink,
  } from '@tabler/icons-svelte';
  import { page } from '$app/state';
  import { setSortParam, setPageParam, pageWindow } from '$lib/table-nav';
  import { modelUrl } from '$lib/model-url';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
  const num = (n: number) => n.toLocaleString();
  const PER_PAGE = 25;

  // Sort + page live in the URL (shallow routing). Default: most-downvoted first — the models to review.
  const sortKey = $derived(page.url.searchParams.get('sort') ?? 'downvotes');
  const sortDir = $derived(page.url.searchParams.get('dir') === 'asc' ? 'asc' : 'desc');
  const pageNum = $derived(Math.max(1, Number(page.url.searchParams.get('page')) || 1));

  const rows = $derived(data.engagement ?? []);
  const sortValue = (m: NonNullable<PageData['engagement']>[number], key: string): number =>
    key === 'comments' ? m.comments : key === 'upvotes' ? m.upvotes : m.downvotes;
  const sorted = $derived.by(() => {
    const list = data.engagement ? [...data.engagement] : [];
    const dir = sortDir === 'desc' ? -1 : 1;
    return list.sort((a, b) => dir * (sortValue(a, sortKey) - sortValue(b, sortKey)));
  });
  const totalPages = $derived(Math.max(1, Math.ceil(sorted.length / PER_PAGE)));
  const curPage = $derived(Math.min(pageNum, totalPages));
  const pageRows = $derived(sorted.slice((curPage - 1) * PER_PAGE, curPage * PER_PAGE));
</script>

{#if data.engagement === null}
  <div class="placeholder">Engagement is temporarily unavailable — please try again shortly.</div>
{:else if rows.length === 0}
  <div class="rounded-lg border border-dashed border-dark-4 p-4 text-sm text-dark-3">
    <strong class="text-dark-2">Nothing to review</strong> — none of your published models have downvotes or comments.
  </div>
{:else}
  <div class="rounded-lg border border-dark-4 bg-dark-6 p-4">
    <p class="mb-3 text-sm text-dark-2">
      Engagement by model
      <span class="text-xs text-dark-3">· all-time · click a column to sort</span>
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
            {#if sortDir === 'asc'}<IconArrowUp size={14} class="text-blue-4" />{:else}<IconArrowDown
                size={14}
                class="text-blue-4"
              />{/if}
          {:else}
            <IconArrowsSort size={14} class="text-dark-4" />
          {/if}
        </button>
      </Table.Head>
    {/snippet}

    {#snippet pager()}
      <div class="flex flex-wrap items-center justify-between gap-2 text-xs text-dark-3">
        <span>{sorted.length} model{sorted.length === 1 ? '' : 's'}</span>
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
          <Table.Head>Model</Table.Head>
          {@render sortHead('comments', 'Comments')}
          {@render sortHead('upvotes', 'Upvotes')}
          {@render sortHead('downvotes', 'Downvotes')}
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {#each pageRows as m (m.modelId)}
          <Table.Row>
            <Table.Cell class="max-w-80">
              <a
                href={modelUrl(m.modelId, m)}
                target="_blank"
                rel="noreferrer"
                class="inline-flex items-center gap-1 truncate text-dark-1 hover:text-white hover:underline"
                title={m.name ?? `Model ${m.modelId}`}
              >
                <span class="truncate">{m.name ?? `Model ${m.modelId}`}</span>
                <IconExternalLink size={13} class="shrink-0 text-dark-3" />
              </a>
            </Table.Cell>
            <Table.Cell class="text-right tabular-nums {m.comments ? 'text-white' : 'text-dark-4'}">
              {m.comments ? num(m.comments) : '—'}
            </Table.Cell>
            <Table.Cell class="text-right tabular-nums {m.upvotes ? 'text-green-4' : 'text-dark-4'}">
              {m.upvotes ? num(m.upvotes) : '—'}
            </Table.Cell>
            <Table.Cell
              class="text-right font-medium tabular-nums {m.downvotes ? 'text-red-4' : 'text-dark-4'}"
            >
              {m.downvotes ? num(m.downvotes) : '—'}
            </Table.Cell>
          </Table.Row>
        {/each}
      </Table.Body>
    </Table.Root>
    {#if totalPages > 1}<div class="mt-3">{@render pager()}</div>{/if}
  </div>
{/if}
