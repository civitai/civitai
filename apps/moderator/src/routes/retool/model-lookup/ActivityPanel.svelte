<script lang="ts">
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { reportDetail, reportDetailEntries, reportStatusVariant } from '$lib/reports';
  import { activityLabel } from '$lib/mod-activity';
  import { userLookupUrl } from '$lib/entity-url';
  import { LINK_CLASS, dateTime, num } from '$lib/format';
  import type { PageData } from './$types';

  type Result = NonNullable<PageData['result']>;

  let {
    reports,
    modActivity,
  }: { reports: Result['reports']; modActivity: Result['modActivity'] } = $props();
</script>

<section class="mb-4 grid gap-4 lg:grid-cols-2">
  <div class="rounded-xl border border-dark-4 bg-dark-6 p-5">
    <h3 class="mb-1 text-sm font-semibold text-white">Reports ({num(reports.total)})</h3>
    <p class="mb-3 text-xs text-dark-2">
      Reports filed against the model itself — not against its images, which are reported per image.
    </p>
    {#if reports.total === 0}
      <p class="text-sm text-dark-2">Never reported.</p>
    {:else}
      {#if reports.rows.length < reports.total}
        <p class="mb-2 text-xs text-amber-300">
          The newest {num(reports.rows.length)} of {num(reports.total)} shown.
        </p>
      {/if}
      <ul class="space-y-1.5 text-sm">
        {#each reports.rows as r (r.id)}
          <li class="flex flex-wrap items-baseline gap-x-2">
            <Badge variant={reportStatusVariant(r.status)}>{r.status}</Badge>
            <span class="text-dark-0">{r.reason}</span>
            {#if r.reportedBy}
              <a href={userLookupUrl(r.reportedById)} class="text-xs {LINK_CLASS}">{r.reportedBy}</a>
            {/if}
            <span class="text-xs text-dark-2">{dateTime(r.createdAt)}</span>
            {#if r.alsoReportedBy?.length}
              <span class="text-xs text-amber-300">+{r.alsoReportedBy.length} also reported</span>
            {/if}
            {#if r.previouslyReviewedCount}
              <span class="text-xs text-dark-2">reviewed {r.previouslyReviewedCount}× before</span>
            {/if}
            {#if r.statusSetBy}
              <span class="text-xs text-dark-2">
                {r.status.toLowerCase()} by {r.statusSetBy}{r.statusSetAt
                  ? ` · ${dateTime(r.statusSetAt)}`
                  : ''}
              </span>
            {/if}
            {#if reportDetail(r.details, 'comment')}
              <p class="w-full wrap-break-word text-xs text-dark-1">
                {reportDetail(r.details, 'comment')}
              </p>
            {:else}
              <!-- An `Automated` report carries no `comment` — its details ARE the detector's finding.
                   Without this the panel is fifty rows reading "Automated · Pending · <date>". -->
              {#each reportDetailEntries(r.details) as [key, value] (key)}
                <span class="text-xs text-dark-1">{key}: {value}</span>
              {/each}
            {/if}
            {#if r.internalNotes}
              <p class="w-full wrap-break-word text-xs text-dark-2">Internal: {r.internalNotes}</p>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </div>

  <div class="rounded-xl border border-dark-4 bg-dark-6 p-5">
    <h3 class="mb-1 text-sm font-semibold text-white">
      Moderator activity ({num(modActivity.rows.length)}{modActivity.truncated ? '+' : ''})
    </h3>
    <p class="mb-3 text-xs text-dark-2">
      Actions taken on this model and on its versions, and who took them.
    </p>
    {#if modActivity.rows.length === 0}
      <p class="text-sm text-dark-2">No recorded moderator activity.</p>
    {:else}
      <ul class="space-y-1 text-sm">
        {#each modActivity.rows as a (a.id)}
          <li class="flex flex-wrap items-baseline gap-x-2">
            <Badge variant="secondary">{activityLabel(a.activity)}</Badge>
            {#if a.versionId}
              <span class="text-xs text-dark-2">version #{a.versionId}</span>
            {/if}
            <span class="text-xs text-dark-2">
              {a.moderatorUsername ?? (a.moderatorId ? `#${a.moderatorId}` : 'system')} · {dateTime(
                a.createdAt
              )}
            </span>
          </li>
        {/each}
      </ul>
      {#if modActivity.truncated}
        <p class="mt-2 text-xs text-amber-300">
          Capped — older actions than these exist and are not shown.
        </p>
      {/if}
    {/if}
  </div>
</section>
