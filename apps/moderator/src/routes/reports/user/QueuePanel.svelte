<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { browser } from '$app/environment';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import ReportQueueColumn from '$lib/components/report-queue/ReportQueueColumn.svelte';
  import ReportRowMeta from '$lib/components/report-queue/ReportRowMeta.svelte';
  import { fetchQueueImageCounts } from './image-counts';
  import type { LayoutData } from './$types';
  import { dateTime, num } from '$lib/format';
  import { userLookupUrl, userReportUrl } from '$lib/entity-url';
  import { itemHref, QUEUE_NAV } from '$lib/report-queue';
  import { SSR_PENDING } from '$lib/ssr-pending';

  let { data, suspectId }: { data: LayoutData; suspectId: number | null } = $props();

  // Deliberately not in `load`: the `remaining` half of this cannot use the covering index and takes
  // seconds across 50 accounts, which would blank the queue behind it on every write.
  //
  // Keyed on the ids, not on the rows: every write reruns the layout and hands back a new array, and
  // refetching on that blanked every row's count. A string only invalidates when the accounts listed
  // actually change.
  const queueIds = $derived(
    data.items
      .map((r) => r.entityId ?? 0)
      .filter(Boolean)
      .join(',')
  );
  const imageCounts = $derived(
    browser ? (queueIds ? fetchQueueImageCounts(queueIds.split(',').map(Number)) : null) : SSR_PENDING
  );

  // Opening an account keeps the queue page, the open tab and the image filters — a moderator triaging
  // with "Only ToS'd" on the Images tab is using it as a lens across accounts. The image page does not
  // survive: it indexes the previous account's grid.
  function open(r: LayoutData['items'][number]) {
    if (r.entityId == null) return;
    goto(itemHref(userReportUrl(r.entityId, page.params.tab), page.url.search), QUEUE_NAV);
  }
</script>

<!-- No Open/Resolved tabs: the status filter already says which reports are listed, and a second
     control over the same question disagreed with it. Resolved reports are Actioned and Unactioned in
     that filter. Every report on the open account is marked, since the account is what is open. -->
<ReportQueueColumn
  basePath="/reports/user"
  queue={data}
  items={data.items}
  isOpen={(r) => r.entityId != null && r.entityId === suspectId}
  onOpen={open}
  dates
>
  {#snippet row(r)}
    <!-- Who first, as the model queue leads with the model. "Banned" sits on this line because it is
         what a moderator scans the queue for. -->
    <div class="flex items-baseline justify-between gap-2">
      <span class="flex min-w-0 items-baseline gap-1.5">
        {#if r.entityId == null}
          <span class="text-muted-foreground">—</span>
        {:else}
          <a href={userLookupUrl(r.entityId)} class="link min-w-0 truncate font-medium">
            {r.suspect?.username ?? `#${r.entityId}`}
          </a>
        {/if}
        {#if r.suspect?.bannedAt}<Badge variant="destructive">banned</Badge>{/if}
        {#if r.suspect?.muted}<Badge variant="destructive">muted</Badge>{/if}
        {#if r.suspect?.deletedAt}<Badge variant="secondary">deleted</Badge>{/if}
      </span>
      <span class="shrink-0 whitespace-nowrap text-xs text-muted-foreground">
        {dateTime(r.createdAt)}
      </span>
    </div>
    <ReportRowMeta report={r}>
      {#await imageCounts then counts}
        {@const c = counts?.[String(r.entityId)]}
        {#if c}
          <span class="text-muted-foreground">{num(c.remaining)} of {num(c.total)} images left</span>
        {/if}
      {:catch}
        <span class="text-muted-foreground">image counts unavailable</span>
      {/await}
    </ReportRowMeta>
  {/snippet}
</ReportQueueColumn>
