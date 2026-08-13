<script lang="ts">
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
  } = $props();

  const lastPage = $derived(Math.max(1, Math.ceil(total / perPage)));

  // Deliberately not in `load`: the `remaining` half of this cannot use the covering index and takes
  // seconds across 50 accounts, which would blank the queue behind it on every write.
  const imageCounts = $derived(
    browser && queue.length
      ? fetchQueueImageCounts(queue.map((r) => r.entityId ?? 0).filter(Boolean))
      : null
  );

  // Both params have to survive each other: a bare `?user=` sent the moderator back to page 1, and a
  // bare `?page=` closed the account they had open.
  // Keeps the image filters, like `pageHref` below — a moderator triaging with "Only ToS'd" set is
  // using it as a lens across accounts, and rebuilding it on every row click is the tax this avoids.
  // The cursor still goes: it indexes the previous account's batch.
  const suspectHref = (entityId: number) => {
    const params = new URLSearchParams(pageState.url.search);
    params.set('page', String(page));
    params.set('user', String(entityId));
    params.delete('cursor');
    return `${pageState.url.pathname}?${params}`;
  };

  // Paging the queue keeps the image filters, which describe the open account, but never the cursor —
  // it indexes a batch belonging to whatever was on screen before.
  const pageHref = (n: number) => {
    const params = new URLSearchParams(pageState.url.search);
    params.set('page', String(n));
    params.delete('cursor');
    if (suspectId) params.set('user', String(suspectId));
    return `?${params}`;
  };

</script>

<section class="mb-4 rounded-xl border border-dark-4 bg-dark-6 p-5">
  <h2 class="mb-1 text-sm font-semibold text-white">Open reports against users ({num(total)})</h2>
  <p class="mb-3 text-xs text-dark-2">
    Pending and Processing, automated reports excluded — the same filters the sidebar counts. Select a
    row to review that account's content below.
  </p>

  {#if error}
    <div
      class="mb-3 rounded-md border border-red-500/30 bg-red-500/10 p-2 text-sm text-red-300"
      role="alert"
    >
      {error}
    </div>
  {/if}

  {#if queue.length === 0}
    <p class="text-sm text-dark-2">Nothing open in this queue.</p>
  {:else}
    <ul class="space-y-2 text-sm">
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
          <div class="relative flex flex-wrap items-baseline gap-x-2">
            <Badge variant={reportStatusVariant(r.status)}>{r.status}</Badge>
            <span class="text-dark-0">
              {reportReasonLabel(r.details, r.reason)}
            </span>
            {#if r.entityId}
              <a href={userLookupUrl(r.entityId)} class="relative z-20 font-medium {LINK_CLASS}">
                {r.suspect?.username ?? `#${r.entityId}`}
              </a>
            {/if}
            {#if r.suspect?.bannedAt}<Badge variant="destructive">banned</Badge>{/if}
            {#if r.suspect?.muted}<Badge variant="destructive">muted</Badge>{/if}
            {#if r.suspect?.deletedAt}<Badge variant="secondary">deleted</Badge>{/if}
            {#if r.alsoReportedByCount > 0}
              <span class="text-xs text-amber-300">+{num(r.alsoReportedByCount)} also reported</span>
            {/if}
            {#await imageCounts then counts}
              {@const c = counts?.[String(r.entityId)]}
              {#if c}
                <span class="text-xs text-dark-2">
                  {num(c.remaining)} of {num(c.total)} images left
                </span>
              {/if}
            {:catch}
              <span class="text-xs text-dark-3">image counts unavailable</span>
            {/await}
            <span class="text-xs text-dark-2">{dateTime(r.createdAt)}</span>
          </div>

          {#if reportDetail(r.details, 'comment')}
            <p class="relative mt-1 wrap-break-word text-dark-1">
              {reportDetail(r.details, 'comment')}
            </p>
          {/if}

          <div class="relative mt-1 flex flex-wrap items-baseline gap-x-2 text-xs text-dark-2">
            {#if r.reportedByUsername}
              <span>
                reported by
                <a href={userLookupUrl(r.reportedByUsername)} class="relative z-20 {LINK_CLASS}">
                  {r.reportedByUsername}
                </a>
              </span>
            {/if}
          </div>

          {#if canAct}
            <form
              method="POST"
              action="?/actionReport"
              use:enhance={onSubmit}
              class="relative z-20 mt-2 flex gap-2"
            >
              <input type="hidden" name="id" value={r.id} />
              <Button type="submit" name="status" value="Actioned" size="xs" variant="destructive" disabled={busy}>
                Action
              </Button>
              <Button type="submit" name="status" value="Unactioned" size="xs" variant="outline" disabled={busy}>
                Dismiss
              </Button>
              {#if r.status !== 'Processing'}
                <Button type="submit" name="status" value="Processing" size="xs" variant="outline" disabled={busy}>
                  Claim
                </Button>
              {/if}
            </form>
          {/if}
        </li>
      {/each}
    </ul>

    {#if lastPage > 1}
      <div class="mt-3 flex items-center gap-3 text-sm">
        {#if page > 1}
          <a href={pageHref(page - 1)} class={LINK_CLASS}>Previous</a>
        {/if}
        <span class="text-xs text-dark-2">Page {page} of {num(lastPage)}</span>
        {#if page < lastPage}
          <a href={pageHref(page + 1)} class={LINK_CLASS}>Next</a>
        {/if}
      </div>
    {/if}
  {/if}
</section>
