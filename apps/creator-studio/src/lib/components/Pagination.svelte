<script lang="ts">
  import PageSizeSelect from '$lib/components/PageSizeSelect.svelte';
  import { setPageParam, pageWindow } from '$lib/table-nav';
  import { IconChevronLeft, IconChevronRight } from '@tabler/icons-svelte';

  // Standard paginator row: count on the left ("353 models"), per-page + page selector on the right. Page nav
  // pushes to the URL (?page=) so Back walks pages; page size lives in the shared analyticsPageSize store. The
  // caller owns curPage/totalPages (it also needs them to slice its rows) and passes the noun for the count.
  let {
    total,
    noun,
    curPage,
    totalPages,
  }: {
    total: number;
    noun: string;
    curPage: number;
    totalPages: number;
  } = $props();
</script>

<div class="flex flex-wrap items-center justify-between gap-2 text-xs text-dark-3">
  <span>{total.toLocaleString()} {noun}{total === 1 ? '' : 's'}</span>
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
            <span class="px-1">…</span>
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
