<script lang="ts">
  import { browser } from '$app/environment';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import type { LayoutData } from './$types';
  import { LINK_CLASS, dateTime, num } from '$lib/format';
  import { entityUrl } from '$lib/entity-url';
  import { reportStatusVariant } from '$lib/reports';
  import { fetchUserReports, type ReportRow } from './user-reports';
  import ListCard from './ListCard.svelte';

  type Result = NonNullable<LayoutData['result']>;

  let {
    userId,
    reportsFiled,
    reportedContent,
    civitaiUrl,
  }: {
    userId: number;
    reportsFiled: Result['reportsFiled'];
    reportedContent: Result['reportedContent'];
    civitaiUrl: string;
  } = $props();

  // Eighteen joins across six entity types, so the rows arrive after the counts rather than holding
  // them up.
  const reports = $derived(browser ? fetchUserReports(userId) : null);


  const filed = $derived<[string, string][]>([
    ['Total', num(reportsFiled.total)],
    ['Actioned', num(reportsFiled.actioned)],
    ['Dismissed', num(reportsFiled.unactioned)],
    ['Pending', num(reportsFiled.pending)],
    // Small (734 rows site-wide) but omitting it made the tiles not sum to Total, with no explanation.
    ['Processing', num(reportsFiled.processing)],
  ]);
</script>

<section class="mb-4 grid gap-4 lg:grid-cols-2">
  <div class="rounded-xl border border-dark-4 bg-dark-6 p-5">
    <h3 class="mb-1 text-sm font-semibold text-white">Reports they filed</h3>
    <p class="mb-3 text-xs text-dark-2">
      How often their reports hold up — the actioned share is of resolved reports only.
    </p>
    <div class="grid grid-cols-2 gap-3 sm:grid-cols-5">
      {#each filed as [label, value] (label)}
        <div>
          <div class="text-xl font-semibold tabular-nums text-white">{value}</div>
          <div class="text-xs text-dark-2">{label}</div>
        </div>
      {/each}
    </div>
    {#if reportsFiled.actionedPercent !== null}
      <p class="mt-3 text-sm text-dark-2">
        <span class="font-semibold text-white">{reportsFiled.actionedPercent}%</span>
        of their resolved reports were actioned.
      </p>
    {/if}
  </div>

  <div class="rounded-xl border border-dark-4 bg-dark-6 p-5">
    <h3 class="mb-1 text-sm font-semibold text-white">Their content that was reported</h3>
    <p class="mb-3 text-xs text-dark-2">
      Distinct items with at least one report, not the number of reports.
    </p>
    <div class="grid grid-cols-2 gap-3 sm:grid-cols-3">
      {#each reportedContent as item (item.label)}
        <div>
          <div
            class="text-xl font-semibold tabular-nums {item.count > 0
              ? 'text-white'
              : 'text-dark-2'}"
          >
            {num(item.count)}
          </div>
          <div class="text-xs text-dark-2">{item.label}</div>
        </div>
      {/each}
    </div>
  </div>
</section>

{#snippet reportList(rows: ReportRow[], limit: number, showReporter: boolean)}
  <ul class="space-y-2 text-sm">
    {#each rows.slice(0, limit) as r (r.id)}
      {@const url = entityUrl(civitaiUrl, r.entityType, r.entityId)}
      <li>
        <div class="flex flex-wrap items-baseline gap-x-2">
          <Badge variant={reportStatusVariant(r.status)}>{r.status}</Badge>
          <span class="text-dark-0">{r.reason}</span>
          {#if url}
            <a href={url} target="_blank" rel="noreferrer" class={LINK_CLASS}>
              {r.entityType.toLowerCase()} {r.entityId}
            </a>
          {:else}
            <span class="text-xs text-dark-2">{r.entityType} {r.entityId ?? ''}</span>
          {/if}
          <span class="text-xs text-dark-2">{dateTime(r.createdAt)}</span>
        </div>
        <div class="flex flex-wrap items-baseline gap-x-2 text-xs text-dark-2">
          {#if showReporter && r.reporterId}
            <span>
              by <a href="?q={r.reporterId}" class={LINK_CLASS}>
                {r.reporter ?? `#${r.reporterId}`}
              </a>
            </span>
          {/if}
          {#if r.statusSetBy}<span>handled by {r.statusSetBy}</span>{/if}
          {#if r.previouslyReviewedCount}
            <span>reviewed {r.previouslyReviewedCount}× before</span>
          {/if}
          {#if r.alsoReportedBy?.length}
            <span>+{r.alsoReportedBy.length} also reported</span>
          {/if}
        </div>
      </li>
    {/each}
  </ul>
{/snippet}

{#await reports}
  <p class="text-sm text-dark-2">Loading report history…</p>
{:then result}
  {#if result}
    {#if result.onUser.length}
      <!-- Open reports against the ACCOUNT, not its content. Retool showed only open ones: a closed
           report is history, and the question here is what is outstanding right now. -->
      <section class="mb-4 rounded-xl border border-amber-500/30 bg-amber-500/10 p-5">
        <h3 class="mb-3 text-sm font-semibold text-amber-200">
          Open reports against this account ({result.onUser.length})
        </h3>
        {@render reportList(result.onUser, result.onUser.length, true)}
      </section>
    {/if}

    <section class="mb-4 grid gap-4 lg:grid-cols-2">
      <ListCard
        title="Reports on their content"
        total={result.received.length}
        shown={8}
        hint="Who reported it, what for, and who resolved it."
      >
        {#snippet children(limit)}
          {@render reportList(result.received, limit, true)}
        {/snippet}
      </ListCard>

      <ListCard
        title="Reports they filed"
        total={result.submitted.length}
        shown={8}
        hint="What they reported and how it was resolved."
      >
        {#snippet children(limit)}
          {@render reportList(result.submitted, limit, false)}
        {/snippet}
      </ListCard>
    </section>
  {/if}
{:catch}
  <p class="text-sm text-red-300">Could not load report history.</p>
{/await}
