<script lang="ts">
  import { reportDetail, reportReasonLabel, reportStatusVariant, reportStatuses } from '$lib/reports';
  import { cn } from '@civitai/ui/utils.js';
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
    statusFilter,
  }: {
    reports: PageData['reports'];
    total: number;
    page: number;
    perPage: number;
    chatId: number | null;
    statusFilter: string[];
  } = $props();

  const totalPages = $derived(Math.max(1, Math.ceil(total / perPage)));
  // A chip toggles its own status in the list and drops the param when the list empties.
  const toggled = (s: string) =>
    (statusFilter.includes(s) ? statusFilter.filter((x) => x !== s) : [...statusFilter, s]).join(',') ||
    null;
</script>

<section class="mb-4 rounded-xl border border-dark-4 bg-dark-6 p-5">
  <h3 class="mb-1 text-sm font-semibold text-white">Reported chats ({num(total)})</h3>
  <p class="mb-3 text-xs text-dark-2">
    Newest first. Defaults to the open ones — the same definition /reports uses — until you pick a
    status below.
  </p>

  <!-- Retool's select1. Without it only Pending/Processing were reachable, so a moderator could not
       check what had already been actioned on an account they were investigating. -->
  <div class="mb-3 flex flex-wrap items-center gap-1.5">
    <span class="text-xs tracking-wide text-dark-2 uppercase">Status</span>
    {#each reportStatuses as s (s)}
      <a
        href={urlWith({ rstatus: toggled(s), rpage: 1 })}
        class={cn(
          'rounded-md border px-2 py-0.5 text-xs',
          statusFilter.includes(s)
            ? 'border-primary bg-primary/15 text-white'
            : 'border-dark-4 text-dark-2 hover:bg-dark-5 hover:text-dark-0'
        )}
      >
        {s}
      </a>
    {/each}
    {#if statusFilter.length}
      <a href={urlWith({ rstatus: null, rpage: 1 })} class="text-xs {LINK_CLASS}">Clear</a>
    {/if}
  </div>

  {#if total === 0}
    <p class="text-sm text-dark-2">
      {statusFilter.length ? 'No chat reports match this filter.' : 'No open chat reports.'}
    </p>
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
          <span class="text-dark-0">{reportReasonLabel(r.details, r.reason)}</span>
          {#if r.reportedByUsername}
            <a href={userLookupUrl(r.reportedByUsername)} class="text-xs {LINK_CLASS}">
              by {r.reportedByUsername}
            </a>
          {/if}
          <span class="text-xs text-dark-2">{dateTime(r.createdAt)}</span>
          <!-- Both are already fetched. One report and thirty are the same row without the first. -->
          {#if r.alsoReportedByCount > 0}
            <span class="text-xs text-amber-300">+{r.alsoReportedByCount} also reported</span>
          {/if}
          {#if r.statusSetByUsername}
            <span class="text-xs text-dark-2">
              {r.status.toLowerCase()} by {r.statusSetByUsername}
            </span>
          {/if}
          {#if reportDetail(r.details, 'comment')}
            <!-- For a chat report the comment IS the substance: "this person DM'd me X". -->
            <p class="w-full wrap-break-word text-xs text-dark-1">
              {reportDetail(r.details, 'comment')}
            </p>
          {/if}
          {#if r.internalNotes}
            <p class="w-full wrap-break-word text-xs text-dark-2">Internal: {r.internalNotes}</p>
          {/if}
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
