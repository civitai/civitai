<script lang="ts">
  import type { Snippet } from 'svelte';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { LINK_CLASS, num } from '$lib/format';
  import { userLookupUrl } from '$lib/entity-url';
  import { reportReasonLabel, reportStatusBadgeClass, type ReportStatus } from '$lib/reports';

  /**
   * A queue row's second line, the same on every layout queue: the report's status, its reason, who
   * filed it and how many more folded in, then the type's own note (`children`) — images left, the
   * item deleted, a minor flag. The first line, what was reported, is the type's own.
   *
   * Four copies had drifted: the model queue's printed the raw reason enum and an unformatted count.
   */
  let {
    report,
    children,
  }: {
    report: {
      status: ReportStatus;
      reason: string;
      details: unknown;
      reportedByUsername: string | null;
      alsoReportedByCount: number | null;
    };
    children?: Snippet;
  } = $props();
</script>

<div class="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
  <Badge class={reportStatusBadgeClass[report.status]}>{report.status}</Badge>
  <span>{reportReasonLabel(report.details, report.reason)}</span>
  <span class="text-muted-foreground">
    by
    {#if report.reportedByUsername}
      <a href={userLookupUrl(report.reportedByUsername)} class={LINK_CLASS}>
        {report.reportedByUsername}
      </a>
    {:else}
      —
    {/if}
    <!-- Everyone else who filed the same report, folded in beside the filer. -->
    {#if report.alsoReportedByCount}
      <span
        class="tabular-nums"
        title={`Also reported by ${report.alsoReportedByCount} other ${report.alsoReportedByCount === 1 ? 'user' : 'users'}`}
      >
        +{num(report.alsoReportedByCount)}
      </span>
    {/if}
  </span>
  {@render children?.()}
</div>
