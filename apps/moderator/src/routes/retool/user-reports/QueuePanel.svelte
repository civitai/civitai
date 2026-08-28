<script lang="ts">
  import Pager from '$lib/components/Pager.svelte';
  import { enhance } from '$app/forms';
  import type { SubmitFunction } from '@sveltejs/kit';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { cn } from '@civitai/ui/utils.js';
  import { page as pageState } from '$app/state';
  import { browser } from '$app/environment';
  import { fetchQueueImageCounts } from './image-counts';
  import type { PageData } from './$types';
  import { LINK_CLASS, dateTime, num } from '$lib/format';
  import { reportDetail, reportReasonLabel, reportStatusVariant } from '$lib/reports';
  import { userLookupUrl } from '$lib/entity-url';
  import ReportQueueFilterBar from '$lib/components/ReportQueueFilterBar.svelte';
  import { clearPaging } from '$lib/paging';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';

  let {
    queue,
    total,
    page,
    perPage,
    suspectId,
    canAct,
    error,
    onSubmit,
    /** The report id currently in flight — only its row's buttons disable, not all 50. */
    pendingId,
    queueFilters,
  }: {
    queue: PageData['queue'];
    total: number;
    page: number;
    perPage: number;
    suspectId: number | null;
    canAct: boolean;
    error: string | null;
    onSubmit: SubmitFunction;
    pendingId: number | null;
    queueFilters: PageData['queueFilters'];
  } = $props();

  const lastPage = $derived(Math.max(1, Math.ceil(total / perPage)));

  // The heading claims parity with the sidebar badge, which is only true unfiltered.
  const defaultView = $derived(
    !pageState.url.searchParams.has('status') &&
      !queueFilters.reportedBy &&
      !queueFilters.reportedFrom &&
      !queueFilters.reportedTo
  );

  // Deliberately not in `load`: the `remaining` half of this cannot use the covering index and takes
  // seconds across 50 accounts, which would blank the queue behind it on every write.
  const imageCounts = $derived(
    browser && queue.length
      ? fetchQueueImageCounts(queue.map((r) => r.entityId ?? 0).filter(Boolean))
      : null
  );

  // Both params have to survive each other: a bare `?user=` sent the moderator back to page 1, and a
  // bare `?page=` closed the account they had open. The image filters survive too — a moderator
  // triaging with "Only ToS'd" set is using it as a lens across accounts. The image page does not:
  // it indexes the previous account's grid.
  const suspectHref = (entityId: number) => {
    const params = new URLSearchParams(pageState.url.search);
    params.set('page', String(page));
    params.set('user', String(entityId));
    clearPaging(params);
    return `${pageState.url.pathname}?${params}`;
  };

  // Keeps the image filters, which describe the open account. Drops the image page — it indexes a
  // grid belonging to whatever was on screen before.
  const pageHref = (n: number) => {
    const params = new URLSearchParams(pageState.url.search);
    params.set('page', String(n));
    clearPaging(params);
    if (suspectId) params.set('user', String(suspectId));
    return `?${params}`;
  };

</script>

<section
  class="mb-4 rounded-xl border border-dark-4 bg-dark-6 p-5 xl:mb-0 xl:flex xl:min-h-0 xl:flex-1 xl:flex-col"
>
  <h2 class="mb-1 text-sm font-semibold text-white">Reports against users ({num(total)})</h2>
  <p class="mb-3 text-xs text-dark-2">
    {#if defaultView}
      <!-- NOT "the same filters the sidebar counts", which this used to claim: the badge counts
           `NEW_REPORT_STATUSES` (Pending alone), because a Processing report can sit under
           investigation for weeks and would read as backlog. This list lands on both. -->
      Pending and Processing, automated reports excluded. The sidebar badge counts Pending only, so it
      reads lower than this.
    {:else}
      Filtered — this count matches neither the default view nor the sidebar badge.
    {/if}
    Select a row to review that account's content below.
  </p>

  <ReportQueueFilterBar
    statuses={queueFilters.statuses}
    reportedBy={queueFilters.reportedBy}
    reportedFrom={queueFilters.reportedFrom}
    reportedTo={queueFilters.reportedTo}
  />

  {#if error}
    <ErrorAlert class="mb-3" message={error} />
  {/if}

  {#if queue.length === 0}
    <p class="text-sm text-dark-2">Nothing open in this queue.</p>
  {:else}
    <!-- `min-h-0` or the list refuses to shrink below its content and the panel overflows again. -->
    <ul class="space-y-2 text-sm xl:min-h-0 xl:flex-1 xl:overflow-y-auto xl:pr-1">
      {#each queue as r (r.id)}
        {@const busy = pendingId === r.id}
        <li
          class={cn(
            'relative rounded-md border p-3',
            suspectId === r.entityId ? 'border-blue-500/40 bg-blue-500/5' : 'border-dark-4'
          )}
        >
          <!-- The row IS the select target: anywhere that is not another control opens this report's
               drill-down. It used to be the suspect's username alone, which is also the one word a
               moderator wants to send to User Lookup — so the two asks are the same change. The
               overlay sits ABOVE the content and the real controls are lifted over it, rather than the
               other way round, so "empty space" means every pixel no control occupies. -->
          {#if r.entityId}
            <a
              href={suspectHref(r.entityId)}
              class="absolute inset-0 z-10 rounded-md"
              aria-label="Open reports for {r.suspect?.username ?? `#${r.entityId}`}"
            ></a>
          {/if}
          <!-- Own column: behind a long username it wrapped to a second line, and "banned" is what a
               moderator scans the queue for. -->
          <div class="relative flex items-start justify-between gap-3">
            <div class="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2">
              <Badge variant={reportStatusVariant(r.status)}>{r.status}</Badge>
              <span class="text-dark-0">
                {reportReasonLabel(r.details, r.reason)}
              </span>
              {#if r.entityId}
                <a href={userLookupUrl(r.entityId)} class="relative z-20 font-medium {LINK_CLASS}">
                  {r.suspect?.username ?? `#${r.entityId}`}
                </a>
              {/if}
              {#if r.alsoReportedByCount > 0}
                <span class="text-xs text-amber-300">
                  +{num(r.alsoReportedByCount)} also reported
                </span>
              {/if}
              {#await imageCounts then counts}
                {@const c = counts?.[String(r.entityId)]}
                {#if c}
                  <span class="text-xs text-dark-2">
                    {num(c.remaining)} of {num(c.total)} images left
                  </span>
                {/if}
              {:catch}
                <span class="text-xs text-dark-2">image counts unavailable</span>
              {/await}
              <span class="text-xs text-dark-2">{dateTime(r.createdAt)}</span>
            </div>
            {#if r.suspect?.bannedAt || r.suspect?.muted || r.suspect?.deletedAt}
              <div class="flex shrink-0 flex-wrap justify-end gap-1">
                {#if r.suspect?.bannedAt}<Badge variant="destructive">banned</Badge>{/if}
                {#if r.suspect?.muted}<Badge variant="destructive">muted</Badge>{/if}
                {#if r.suspect?.deletedAt}<Badge variant="secondary">deleted</Badge>{/if}
              </div>
            {/if}
          </div>

          {#if reportDetail(r.details, 'comment')}
            <p class="relative mt-1 wrap-break-word text-dark-1">
              {reportDetail(r.details, 'comment')}
            </p>
          {/if}

          <!-- Attribution and the buttons share a row. Stacked, each report cost a line of dead space
               either side of the controls, and roughly half a row was cut off at the fold. -->
          <div class="relative mt-1 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
            <span class="text-xs text-dark-2">
              {#if r.reportedByUsername}
                reported by
                <a href={userLookupUrl(r.reportedByUsername)} class="relative z-20 {LINK_CLASS}">
                  {r.reportedByUsername}
                </a>
              {/if}
            </span>

            {#if canAct}
              <form
                method="POST"
                action="?/actionReport"
                use:enhance={onSubmit}
                class="relative z-20 flex gap-2"
              >
                <input type="hidden" name="id" value={r.id} />
                <Button type="submit" name="status" value="Actioned" size="xs" variant="destructive" disabled={busy}>
                  Action
                </Button>
                <Button type="submit" name="status" value="Unactioned" size="xs" variant="outline" disabled={busy}>
                  Unaction
                </Button>
              </form>
            {/if}
          </div>
        </li>
      {/each}
    </ul>

    <Pager {page} pageCount={lastPage} href={pageHref} />
  {/if}
</section>
