<script lang="ts">
  import { reportStatusVariant } from '$lib/reports';
  import { goto } from '$app/navigation';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import {
    Pagination,
    PaginationContent,
    PaginationEllipsis,
    PaginationItem,
    PaginationLink,
    PaginationNext,
    PaginationPrevious,
  } from '@civitai/ui/components/ui/pagination/index.js';
  import { LINK_CLASS, dateTime, num } from '$lib/format';
  import { userLookupUrl } from '$lib/entity-url';
  import { chatUrl, urlWith } from '../url';
  import type { PageData } from './$types';

  let {
    reports,
    total,
    page,
    perPage,
    chatId,
  }: {
    reports: PageData['reports'];
    total: number;
    page: number;
    perPage: number;
    chatId: number | null;
  } = $props();

  const totalPages = $derived(Math.max(1, Math.ceil(total / perPage)));
</script>

<section class="mb-4 rounded-xl border border-dark-4 bg-dark-6 p-5">
  <h3 class="mb-1 text-sm font-semibold text-white">Reported chats ({num(total)})</h3>
  <p class="mb-3 text-xs text-dark-2">
    Open reports, newest first — the same view and the same definition of "open" as /reports.
  </p>

  {#if total === 0}
    <p class="text-sm text-dark-2">No open chat reports.</p>
  {:else}
    <ul class="space-y-1.5 text-sm">
      {#each reports as r (r.id)}
        <li
          class="flex flex-wrap items-baseline gap-x-2 rounded-md px-2 py-1 {r.entityId === chatId
            ? 'bg-dark-5'
            : ''}"
        >
          <Badge variant={reportStatusVariant(r.status)}>{r.status}</Badge>
          {#if r.entityId}
            <a href={chatUrl(r.entityId)} class={LINK_CLASS}>chat {r.entityId}</a>
          {/if}
          <span class="text-dark-0">{r.reason}</span>
          {#if r.reportedByUsername}
            <a href={userLookupUrl(r.reportedByUsername)} class="text-xs {LINK_CLASS}">
              by {r.reportedByUsername}
            </a>
          {/if}
          <span class="text-xs text-dark-2">{dateTime(r.createdAt)}</span>
        </li>
      {/each}
    </ul>

    <div class="mt-4 flex flex-wrap items-center justify-between gap-2">
      <span class="text-xs text-dark-2">Page {page} of {num(totalPages)}</span>
      <Pagination
        count={total}
        perPage={perPage}
        {page}
        onPageChange={(p) => p !== page && goto(urlWith({ rpage: p }))}
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
    </div>
  {/if}
</section>
