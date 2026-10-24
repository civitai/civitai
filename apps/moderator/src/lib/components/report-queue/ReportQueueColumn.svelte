<script lang="ts" generics="T extends { id: number }">
  import type { Snippet } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { cn } from '@civitai/ui/utils.js';
  import ReportFilters from '$lib/components/ReportFilters.svelte';
  import { LINK_CLASS, num } from '$lib/format';
  import { clearPaging } from '$lib/paging';
  import type { ReportQueueData } from '$lib/server/report-queue-load';

  /**
   * The queue column every non-table report queue shares: the filters (or the note for a single
   * `?report=` view), the list, and a footer with the range and Prev/Next — styled as the triage
   * pages' list (`TriageShell`'s `flush`, `TriageRow`). The page title is `ReportQueueShell`'s.
   *
   * Every filter and page change goes to `basePath` — the bare queue — so the new view opens on its own
   * first item rather than one the last view had open. `clearPaging` drops the open item's own pagers.
   * `onNavigate` is for whatever else the page resets.
   *
   * The row's content is the page's (`row`); what is the same everywhere is how a row opens: a click on
   * the row, not on a link or button inside it, and not a drag to copy text out of it.
   */
  let {
    basePath,
    queue,
    items,
    isOpen,
    onOpen,
    row,
    dates = false,
    onNavigate,
    toolbar,
  }: {
    /** The bare queue, e.g. `/reports/model`. */
    basePath: string;
    /** The layout's `loadReportQueue` result: filter state and paging. */
    queue: Omit<ReportQueueData, 'items'>;
    /** The rows, as the page hydrated them. */
    items: T[];
    isOpen: (item: T) => boolean;
    /** Not called for a row with nothing to open — the page decides what that is. */
    onOpen: (item: T) => void;
    row: Snippet<[T]>;
    /** The queue's load applies the reported-date range (`loadReportQueue`'s `dates`). */
    dates?: boolean;
    onNavigate?: () => void;
    /** Queue-wide actions under the filters — the post queue's sweep. Not shown in a single-report view. */
    toolbar?: Snippet;
  } = $props();

  const totalPages = $derived(Math.max(1, Math.ceil(queue.totalItems / queue.limit)));
  const firstShown = $derived((queue.page - 1) * queue.limit + 1);
  const lastShown = $derived((queue.page - 1) * queue.limit + items.length);

  function navigate(href: string) {
    const url = new URL(href, page.url);
    url.searchParams.delete('report');
    clearPaging(url.searchParams);
    onNavigate?.();
    goto(`${basePath}${url.search}`, { keepFocus: true, noScroll: true });
  }

  const pageHref = (n: number) => {
    const url = new URL(page.url);
    url.searchParams.set('page', String(n));
    return url.pathname + url.search;
  };

  function onRowClick(e: MouseEvent, item: T) {
    if ((e.target as HTMLElement).closest('a, button')) return;
    if (window.getSelection()?.toString()) return;
    onOpen(item);
  }

  function onRowKeydown(e: KeyboardEvent, item: T) {
    if (e.target !== e.currentTarget) return;
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    onOpen(item);
  }
</script>

<div class="flex shrink-0 flex-col gap-2 border-b border-dark-4 px-3 py-2.5">
  {#if queue.singleReport}
    <p class="m-0 text-xs text-dark-2">
      Showing report #{queue.singleReport} only.
      <a href={basePath} class={LINK_CLASS}>Back to the queue</a>
    </p>
  {:else}
    <ReportFilters
      statuses={queue.statuses}
      reasons={queue.reasons}
      reportedBy={queue.reportedBy}
      hidingAutomated={queue.hidingAutomated}
      statusCounts={queue.statusCounts}
      dates={dates ? { from: queue.reportedFrom, to: queue.reportedTo } : undefined}
      {navigate}
    />
    {#if toolbar}{@render toolbar()}{/if}
  {/if}
</div>

<!-- The open item marked as a triage row is: a blue edge on a raised row. `min-h-0` or the list refuses
     to shrink and the column overflows; `relative` for the reason in `ReportDetailColumns`. -->
<ul
  role="listbox"
  aria-label="Reports"
  class="relative m-0 flex list-none flex-col p-0 text-sm xl:min-h-0 xl:flex-1 xl:overflow-y-auto"
>
  {#each items as item (item.id)}
    {@const open = isOpen(item)}
    <li
      role="option"
      tabindex={0}
      aria-selected={open}
      class={cn(
        'cursor-pointer border-l-2 px-3 py-2.5 transition-colors hover:bg-dark-5',
        open ? 'border-blue-500 bg-dark-5' : 'border-transparent'
      )}
      onclick={(e) => onRowClick(e, item)}
      onkeydown={(e) => onRowKeydown(e, item)}
    >
      {@render row(item)}
    </li>
  {:else}
    <li role="presentation" class="py-8 text-center text-dark-2">No reports match this view.</li>
  {/each}
</ul>

<!-- Buttons, not links: a page change also opens the new page's first item. -->
<!-- Also on an empty later page (a stale ?page=, or its last report ruled), so Prev still leads back. -->
{#if items.length || queue.page > 1}
  <footer
    class="flex shrink-0 items-center justify-between gap-3 border-t border-dark-4 px-3 py-2 text-xs text-dark-2"
  >
    <span class="tabular-nums">
      {items.length ? `${num(firstShown)} to ${num(lastShown)} of ${num(queue.totalItems)}` : `Page ${queue.page}`}
    </span>
    <span class="flex gap-2.5">
      {#if queue.page > 1}
        <button type="button" class={LINK_CLASS} onclick={() => navigate(pageHref(queue.page - 1))}>
          Prev
        </button>
      {:else}
        <span aria-disabled="true">Prev</span>
      {/if}
      {#if queue.page < totalPages}
        <button type="button" class={LINK_CLASS} onclick={() => navigate(pageHref(queue.page + 1))}>
          Next
        </button>
      {:else}
        <span aria-disabled="true">Next</span>
      {/if}
    </span>
  </footer>
{/if}
