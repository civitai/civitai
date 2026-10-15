<script lang="ts" generics="T extends { id: number }">
  import type { Snippet } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import ReportFilters from '$lib/components/ReportFilters.svelte';
  import { clearPaging } from '$lib/paging';
  import type { ReportQueueData } from '$lib/server/report-queue-load';

  /**
   * The queue column every non-table report queue shares: its title, the filters (or the note for a
   * single `?report=` view), the striped list, and Prev/Next.
   *
   * Every filter and page change goes to `basePath` — the bare queue — so the new view opens on its own
   * first item rather than one the last view had open. `clearPaging` drops the open item's own pagers.
   * `onNavigate` is for whatever else the page resets.
   *
   * The row's content is the page's (`row`); what is the same everywhere is how a row opens: a click on
   * the row, not on a link or button inside it, and not a drag to copy text out of it.
   */
  let {
    title,
    basePath,
    queue,
    items,
    isOpen,
    onOpen,
    row,
    dates = false,
    onNavigate,
  }: {
    title: string;
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
  } = $props();

  const totalPages = $derived(Math.max(1, Math.ceil(queue.totalItems / queue.limit)));

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

<header>
  <h1 class="m-0 text-xl font-semibold text-white">{title}</h1>
</header>

{#if queue.singleReport}
  <p class="m-0 text-xs text-muted-foreground">
    Showing report #{queue.singleReport} only.
    <a href={basePath} class="link">Back to the queue</a>
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
{/if}

<!-- Striped, and the open item marked in blue. The stripe is dropped on the open row rather than
     layered under it, so which wins never depends on Tailwind's variant order. `min-h-0` or the list
     refuses to shrink and the column overflows; `relative` for the reason in `ReportDetailColumns`. -->
<ul
  role="listbox"
  aria-label="Reports"
  class="relative flex flex-col gap-1 text-sm xl:min-h-0 xl:flex-1 xl:overflow-y-auto xl:pr-1"
>
  {#each items as item (item.id)}
    {@const open = isOpen(item)}
    <li
      role="option"
      tabindex={0}
      aria-selected={open}
      class="cursor-pointer rounded-md border px-3 py-2 {open
        ? 'border-blue-500/40 bg-blue-500/15 shadow-[inset_3px_0_0_var(--color-blue-500)]'
        : 'border-transparent odd:bg-dark-7/40 hover:bg-dark-7/70'}"
      onclick={(e) => onRowClick(e, item)}
      onkeydown={(e) => onRowKeydown(e, item)}
    >
      {@render row(item)}
    </li>
  {:else}
    <li class="py-8 text-center text-muted-foreground">No reports match this view.</li>
  {/each}
</ul>

<!-- Prev/next rather than numbered pages, which do not fit a column this narrow. Buttons, not links:
     a page change also opens the new page's first item. -->
{#if totalPages > 1}
  <div class="flex items-center justify-between gap-2 text-sm">
    <Button
      size="sm"
      variant="ghost"
      disabled={queue.page <= 1}
      onclick={() => navigate(pageHref(queue.page - 1))}
    >
      ← Previous
    </Button>
    <span class="text-muted-foreground">Page {queue.page} of {totalPages}</span>
    <Button
      size="sm"
      variant="ghost"
      disabled={queue.page >= totalPages}
      onclick={() => navigate(pageHref(queue.page + 1))}
    >
      Next →
    </Button>
  </div>
{/if}
