<script lang="ts">
  import { reportDetail, reportStatusVariant } from '$lib/reports';
  import { userLookupUrl } from '$lib/entity-url';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { LINK_CLASS, dateTime } from '$lib/format';
  import type { PageData } from './$types';

  type Result = NonNullable<PageData['result']>;

  let {
    reports,
    modActivity,
    reactions,
  }: {
    reports: Result['reports'];
    modActivity: Result['modActivity'];
    reactions: Result['reactions'];
  } = $props();

  const SHOWN = 8;
  let expandedReactions = $state(false);
  const visibleReactions = $derived(
    expandedReactions ? reactions.rows : reactions.rows.slice(0, SHOWN)
  );
</script>

<section class="mb-4 grid gap-4 lg:grid-cols-3">
  <div class="rounded-xl border border-dark-4 bg-dark-6 p-5">
    <h3 class="mb-3 text-sm font-semibold text-white">Reports ({reports.length})</h3>
    {#if reports.length === 0}
      <p class="text-sm text-dark-2">Never reported.</p>
    {:else}
      <ul class="space-y-1.5 text-sm">
        {#each reports as r (r.id)}
          <li class="flex flex-wrap items-baseline gap-x-2">
            <Badge variant={reportStatusVariant(r.status)}>{r.status}</Badge>
            <span class="text-dark-0">{r.reason}</span>
            {#if r.reportedBy}
              <a href={userLookupUrl(r.reportedById)} class="text-xs {LINK_CLASS}">
                {r.reportedBy}
              </a>
            {/if}
            <span class="text-xs text-dark-2">{dateTime(r.createdAt)}</span>
            <!-- One report and thirty reports are the same row without this. -->
            {#if r.alsoReportedBy?.length}
              <span class="text-xs text-amber-300">
                +{r.alsoReportedBy.length} also reported
              </span>
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
              <!-- The reporter's own words: the only part of a report that says what happened. -->
              <p class="w-full wrap-break-word text-xs text-dark-1">
                {reportDetail(r.details, 'comment')}
              </p>
            {/if}
            {#if r.internalNotes}
              <p class="w-full wrap-break-word text-xs text-dark-2">
                Internal: {r.internalNotes}
              </p>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </div>

  <div class="rounded-xl border border-dark-4 bg-dark-6 p-5">
    <h3 class="mb-1 text-sm font-semibold text-white">
      Moderator activity ({modActivity.rows.length}{modActivity.truncated ? '+' : ''})
    </h3>
    <p class="mb-3 text-xs text-dark-2">Actions taken on this image, and who took them.</p>
    {#if modActivity.rows.length === 0}
      <p class="text-sm text-dark-2">No recorded moderator activity.</p>
    {:else}
      <ul class="space-y-1 text-sm">
        {#each modActivity.rows as a (a.id)}
          <li class="flex flex-wrap items-baseline gap-x-2">
            <Badge variant="secondary">{a.activity}</Badge>
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

  <div class="rounded-xl border border-dark-4 bg-dark-6 p-5">
    <h3 class="mb-1 text-sm font-semibold text-white">
      Reactions ({reactions.rows.length}{reactions.truncated ? '+' : ''})
    </h3>
    <p class="mb-3 text-xs text-dark-2">Most recent first.</p>
    {#if reactions.rows.length === 0}
      <p class="text-sm text-dark-2">No reactions.</p>
    {:else}
      <ul class="space-y-1 text-sm">
        {#each visibleReactions as r (r.key)}
          <li class="flex flex-wrap items-baseline gap-x-2">
            <Badge variant="secondary">{r.reaction}</Badge>
            <a href={userLookupUrl(r.userId)} class={LINK_CLASS}>
              {r.username ?? `#${r.userId}`}
            </a>
            {#if r.bannedAt}<Badge variant="destructive">banned</Badge>{/if}
            <span class="text-xs text-dark-2">{dateTime(r.createdAt)}</span>
          </li>
        {/each}
      </ul>
      {#if reactions.rows.length > SHOWN}
        <button
          type="button"
          class="mt-3 text-sm {LINK_CLASS}"
          onclick={() => (expandedReactions = !expandedReactions)}
        >
          {expandedReactions ? 'Show less' : `Show ${reactions.rows.length} loaded`}
        </button>
      {/if}
      {#if reactions.truncated}
        <p class="mt-2 text-xs text-amber-300">
          Capped — this image has more reactions than are loaded here.
        </p>
      {/if}
    {/if}
  </div>
</section>
