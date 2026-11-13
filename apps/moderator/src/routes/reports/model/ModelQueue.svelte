<script lang="ts">
  import { dateTime } from '$lib/format';
  import { getReportItemUrl } from '$lib/reports';
  import OwnerFlaggedMinorBadge from '$lib/components/minor-flags/OwnerFlaggedMinorBadge.svelte';
  import ReportQueueColumn from '$lib/components/report-queue/ReportQueueColumn.svelte';
  import ReportRowMeta from '$lib/components/report-queue/ReportRowMeta.svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { itemHref, QUEUE_NAV } from '$lib/report-queue';
  import type { LayoutData } from './$types';

  let { data }: { data: LayoutData } = $props();

  // The open model is the child page's. Read through `page.data` because a layout's own `data` is
  // only its load's.
  const openModel = $derived(
    (page.data as { item?: { modelId: number } | null }).item?.modelId ?? null
  );

  // Opening a model keeps the queue page and filters; a single-report view does not survive it.
  function open(modelId: number | null) {
    if (modelId == null) return;
    goto(itemHref(`/reports/model/${modelId}`, page.url.search), QUEUE_NAV);
  }

  const ownerFlaggedMinor = $derived(new Set(data.ownerFlaggedMinor));
</script>

<ReportQueueColumn
  basePath="/reports/model"
  queue={data}
  items={data.items}
  isOpen={(r) => r.entityId != null && r.entityId === openModel}
  onOpen={(r) => open(r.entityId)}
>
  {#snippet row(report)}
    {@const itemUrl = getReportItemUrl(data.civitaiUrl, data.type, report.entityId, report.contextUrl)}
    {@const modelName = data.models.find((m) => m.id === report.entityId)?.name}
    <!-- Identity first: "which model is this about" used to cost a click or a trip to the site. -->
    <div class="flex items-baseline justify-between gap-2">
      <span class="min-w-0 truncate font-medium">
        {#if report.entityId == null}
          <span class="text-muted-foreground">—</span>
        {:else if itemUrl}
          <a href={itemUrl} target="_blank" rel="noreferrer" class="link">
            {modelName ?? `#${report.entityId}`}
          </a>
        {:else}
          {modelName ?? `#${report.entityId}`}
        {/if}
      </span>
      <span class="shrink-0 whitespace-nowrap text-xs text-muted-foreground">
        {dateTime(report.createdAt)}
      </span>
    </div>
    <ReportRowMeta report={report}>
      {#if report.entityId != null && ownerFlaggedMinor.has(report.entityId)}<OwnerFlaggedMinorBadge />{/if}
    </ReportRowMeta>
  {/snippet}
</ReportQueueColumn>
