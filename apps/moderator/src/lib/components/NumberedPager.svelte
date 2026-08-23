<script lang="ts">
  import {
    Pagination,
    PaginationContent,
    PaginationEllipsis,
    PaginationItem,
    PaginationLink,
    PaginationNext,
    PaginationPrevious,
  } from '@civitai/ui/components/ui/pagination/index.js';
  import { num } from '$lib/format';

  let {
    page,
    total,
    perPage,
    onPageChange,
    label = 'items',
  }: {
    page: number;
    total: number;
    perPage: number;
    onPageChange: (page: number) => void;
    /** Plural noun for the count line — "1,204 images · page 3 of 21". */
    label?: string;
  } = $props();

  const pageCount = $derived(Math.max(1, Math.ceil(total / perPage)));
</script>

{#if pageCount > 1}
  <div class="mt-6 flex flex-col items-center gap-1">
    <!-- Function binding, not `page={page}`: the primitive declares `page` as `$bindable` and writes
         to it on every click, and a one-way prop leaves that write as a child-local override — so a
         click the parent resolves back to the same number latches the pager off the grid. -->
    <Pagination
      count={total}
      {perPage}
      bind:page={() => page, (p) => p !== page && onPageChange(p)}
    >
      {#snippet children({ pages, currentPage })}
        <PaginationContent>
          <PaginationItem>
            <PaginationPrevious />
          </PaginationItem>
          {#each pages as p (p.key)}
            {#if p.type === 'ellipsis'}
              <PaginationItem>
                <PaginationEllipsis />
              </PaginationItem>
            {:else}
              <PaginationItem>
                <PaginationLink page={p} isActive={currentPage === p.value}>
                  {p.value}
                </PaginationLink>
              </PaginationItem>
            {/if}
          {/each}
          <PaginationItem>
            <PaginationNext />
          </PaginationItem>
        </PaginationContent>
      {/snippet}
    </Pagination>
    <span class="text-xs text-dark-2">
      {num(total)}
      {label} · page {num(page)} of {num(pageCount)}
    </span>
  </div>
{/if}
