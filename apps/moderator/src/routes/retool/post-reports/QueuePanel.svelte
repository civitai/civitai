<script lang="ts">
  import Pager from '$lib/components/Pager.svelte';
  import { enhance } from '$app/forms';
  import type { SubmitFunction } from '@sveltejs/kit';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { cn } from '@civitai/ui/utils.js';
  import { page as pageState } from '$app/state';
  import type { PageData } from './$types';
  import { LINK_CLASS, dateTime, num } from '$lib/format';
  import { reportDetail, reportReasonLabel, reportStatusVariant } from '$lib/reports';
  import { userLookupUrl } from '$lib/entity-url';
  import ReportQueueFilterBar from '$lib/components/ReportQueueFilterBar.svelte';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';

  let {
    queue,
    total,
    page,
    perPage,
    postId,
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
    postId: number | null;
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

  // Both params have to survive each other: a bare `?post=` would send the moderator back to page 1,
  // and a bare `?page=` would close the post they had open.
  const postHref = (entityId: number) => {
    const params = new URLSearchParams(pageState.url.search);
    params.set('page', String(page));
    params.set('post', String(entityId));
    return `${pageState.url.pathname}?${params}`;
  };

  const pageHref = (n: number) => {
    const params = new URLSearchParams(pageState.url.search);
    params.set('page', String(n));
    if (postId) params.set('post', String(postId));
    return `?${params}`;
  };
</script>

<section
  class="mb-4 rounded-xl border border-dark-4 bg-dark-6 p-5 xl:mb-0 xl:flex xl:min-h-0 xl:flex-1 xl:flex-col"
>
  <h2 class="mb-1 text-sm font-semibold text-white">Reports against posts ({num(total)})</h2>
  <p class="mb-3 text-xs text-dark-2">
    {#if defaultView}
      Pending and Processing, automated reports excluded. The sidebar badge counts Pending only, so it
      reads lower than this.
    {:else}
      Filtered — this count matches neither the default view nor the sidebar badge.
    {/if}
    Select a row to review that post's images below.
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
        {@const p = r.post}
        <li
          class={cn(
            'relative rounded-md border p-3',
            postId === r.entityId ? 'border-blue-500/40 bg-blue-500/5' : 'border-dark-4'
          )}
        >
          <!-- The row IS the select target: anywhere that is not another control opens this report's
               drill-down. The overlay sits ABOVE the content and the real controls are lifted over it,
               so "empty space" means every pixel no control occupies. -->
          {#if r.entityId}
            <a
              href={postHref(r.entityId)}
              class="absolute inset-0 z-10 rounded-md"
              aria-label="Open post #{r.entityId}"
            ></a>
          {/if}
          <div class="relative flex flex-wrap items-baseline gap-x-2">
            <Badge variant={reportStatusVariant(r.status)}>{r.status}</Badge>
            <span class="text-dark-0">{reportReasonLabel(r.details, r.reason)}</span>
            <span class="font-medium text-white">Post #{r.entityId}</span>
            {#if p?.username}
              <a href={userLookupUrl(p.username)} class="relative z-20 {LINK_CLASS}">
                {p.username}
              </a>
            {/if}
            {#if p?.bannedAt}<Badge variant="destructive">banned</Badge>{/if}
            {#if p == null}
              <!-- A report survives its post's deletion. Saying so is what stops a moderator reading
                   the empty drill-down as a broken page. -->
              <Badge variant="secondary">post deleted</Badge>
            {:else}
              <span class="text-xs text-dark-2">
                {num(p.imageCount - p.blockedCount)} of {num(p.imageCount)} images left
              </span>
              {#if p.imageCount > 0 && p.blockedCount === p.imageCount}
                <span class="text-xs text-emerald-300">already resolved by content</span>
              {/if}
            {/if}
            {#if r.alsoReportedByCount > 0}
              <span class="text-xs text-amber-300">+{num(r.alsoReportedByCount)} also reported</span>
            {/if}
            <span class="text-xs text-dark-2">{dateTime(r.createdAt)}</span>
          </div>

          {#if reportDetail(r.details, 'comment')}
            <p class="relative mt-1 wrap-break-word text-dark-1">
              {reportDetail(r.details, 'comment')}
            </p>
          {/if}

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
