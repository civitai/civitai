<script lang="ts">
  import { dateTime } from '$lib/format';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { reportEntityLabels, reportStatusBadgeClass, getReportItemUrl } from '$lib/reports';
  import { userLookupUrl } from '$lib/entity-url';
  import OwnerFlaggedMinorBadge from '$lib/components/minor-flags/OwnerFlaggedMinorBadge.svelte';
  import ReportQueueColumn from '$lib/components/report-queue/ReportQueueColumn.svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { clearPaging } from '$lib/paging';
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
    const params = new URLSearchParams(page.url.search);
    params.delete('report');
    clearPaging(params);
    const query = params.size ? `?${params}` : '';
    goto(`/reports/model/${modelId}${query}`, { noScroll: true, keepFocus: true });
  }

  const ownerFlaggedMinor = $derived(new Set(data.ownerFlaggedMinor));
</script>

<ReportQueueColumn
  title="{reportEntityLabels[data.type]} reports"
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
    <div class="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
      <Badge class={reportStatusBadgeClass[report.status]}>{report.status}</Badge>
      <span>{report.reason}</span>
      {#if report.entityId != null && ownerFlaggedMinor.has(report.entityId)}<OwnerFlaggedMinorBadge />{/if}
      <span class="text-muted-foreground">
        by
        {#if report.reportedByUsername}
          <a href={userLookupUrl(report.reportedByUsername)} class="link">{report.reportedByUsername}</a>
        {:else}
          —
        {/if}
        <!-- Everyone else who filed the same report, folded in beside the filer. -->
        {#if report.alsoReportedByCount}
          <span
            class="tabular-nums"
            title={`Also reported by ${report.alsoReportedByCount} other ${report.alsoReportedByCount === 1 ? 'user' : 'users'}`}
          >
            +{report.alsoReportedByCount}
          </span>
        {/if}
      </span>
    </div>
  {/snippet}
</ReportQueueColumn>
