<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import ReportQueueColumn from '$lib/components/report-queue/ReportQueueColumn.svelte';
  import ReportRowMeta from '$lib/components/report-queue/ReportRowMeta.svelte';
  import type { LayoutData } from './$types';
  import { LINK_CLASS, dateTime } from '$lib/format';
  import { reportPath } from '$lib/reports';
  import { userLookupUrl } from '$lib/entity-url';
  import { entityReportUrl } from '$lib/entity-report-queues';
  import { itemHref, QUEUE_NAV } from '$lib/report-queue';

  let { data }: { data: LayoutData } = $props();

  // The open item is the child page's. Read through `page.data` because a layout's own `data` is only
  // its load's.
  const openId = $derived((page.data as { item?: { id: number } | null }).item?.id ?? null);

  // Opening an item keeps the queue page and the filters; a single-report view does not survive it.
  function open(id: number | null) {
    if (id == null) return;
    goto(itemHref(entityReportUrl(data.queueType, id), page.url.search), QUEUE_NAV);
  }
</script>

<ReportQueueColumn
  basePath={reportPath(data.queueType)}
  queue={data}
  items={data.items}
  isOpen={(r) => r.entityId != null && r.entityId === openId}
  onOpen={(r) => open(r.entityId)}
  dates
>
  {#snippet row(r)}
    {@const s = r.subject}
    <!-- What was reported and whose, as the other queues lead with the account, model or post;
         "banned" sits on this line because it is what a moderator scans the queue for. -->
    <div class="flex items-baseline justify-between gap-2">
      <span class="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
        <span class="font-medium wrap-break-word">
          {s?.title ?? `${data.labels.noun} #${r.entityId ?? '—'}`}
        </span>
        {#if s?.userId != null}
          <a href={userLookupUrl(s.username ?? s.userId)} class="{LINK_CLASS} text-xs">
            {s.username ?? `#${s.userId}`}
          </a>
        {/if}
        {#if s?.bannedAt}<Badge variant="destructive">banned</Badge>{/if}
      </span>
      <span class="shrink-0 whitespace-nowrap text-xs text-muted-foreground">
        {dateTime(r.createdAt)}
      </span>
    </div>
    <ReportRowMeta report={r}>
      {#if s == null}
        <!-- A report survives what it is about. Saying so is what stops a moderator reading the empty
             panel as a broken page. -->
        <Badge variant="secondary">{data.labels.noun} deleted</Badge>
      {:else if s.note}
        <span class="text-muted-foreground">{s.note}</span>
      {/if}
    </ReportRowMeta>
  {/snippet}
</ReportQueueColumn>
