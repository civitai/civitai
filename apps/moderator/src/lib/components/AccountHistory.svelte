<script lang="ts">
  import { untrack } from 'svelte';
  import { browser } from '$app/environment';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import StrikeList from '$lib/components/StrikeList.svelte';
  import { reportReasonLabel, reportStatusVariant } from '$lib/reports';
  import { LINK_CLASS, dateTime } from '$lib/format';
  import { entityUrl, userLookupUrl } from '$lib/entity-url';
  import { activityLabel } from '$lib/mod-activity';
  import type { LiveStrike } from '$lib/server/user-lookup.service';
  import type { UserNote } from '$lib/server/moderation-memory.service';
  import type { ModActivityRow, RetoolActivityRow } from '$lib/server/user-account.service';
  import type { UserReportRow } from '$lib/server/user-reports.service';

  let {
    userId,
    civitaiUrl,
    strikes,
    modActivity,
    ratingActivity,
    retoolActivity,
    reportsOnUser,
    notes,
    truncated,
  }: {
    userId: number;
    civitaiUrl: string;
    strikes: LiveStrike[];
    /** Enforcement rows only. The rating/tagging ones are `ratingActivity` — two separately limited
     *  queries, because filtering one merged window drops rows the window was already truncated by. */
    modActivity: ModActivityRow[];
    ratingActivity: ModActivityRow[];
    retoolActivity: RetoolActivityRow[];
    reportsOnUser: UserReportRow[];
    notes: UserNote[];
    /** Whether each source had more rows than the panel was given. Every count here is `.length`
     *  over a capped list, so without this the cap renders as the total. See `account-history.ts`. */
    truncated: { strikes: boolean; activity: boolean; reports: boolean };
  } = $props();

  /** A capped count must never read as a complete one. */
  const atLeast = (n: number, more: boolean) => (more ? `${n}+` : `${n}`);

  /** These rows also arrive over JSON, where a `Date` is a `string`; one snippet renders both. */
  type DisplayReportRow = Omit<UserReportRow, 'createdAt' | 'statusSetAt'> & {
    createdAt: Date | string;
    statusSetAt: Date | string | null;
  };

  const PREVIEW = 8;

  let showRatings = $state(false);
  let expandActivity = $state(false);

  // Selecting the next report is a `?user=` navigation, not a remount, so without this the moderator
  // opens the next account with someone else's list already expanded and rating rows mixed in.
  $effect(() => {
    userId;
    untrack(() => {
      showRatings = false;
      expandActivity = false;
    });
  });

  const activityRows = $derived(
    showRatings
      ? [...modActivity, ...ratingActivity].sort(
          (a, b) => b.createdAt.getTime() - a.createdAt.getTime()
        )
      : modActivity
  );
  const shownActivity = $derived(expandActivity ? activityRows : activityRows.slice(0, PREVIEW));
  const shownRetool = $derived(expandActivity ? retoolActivity : retoolActivity.slice(0, PREVIEW));
  const activityHidden = $derived(
    activityRows.length - shownActivity.length + (retoolActivity.length - shownRetool.length)
  );

  // Client-fetched: a join per entity type, and this panel re-renders on every queue row click.
  // The catch matters — a moderator with the queue but not User Lookup gets a 403 here.
  const contentReports = $derived(
    browser
      ? fetch(`/api/user-reports/${userId}?only=received&human=1&limit=20`)
          .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
          .then((d: { received: DisplayReportRow[] }) => d.received)
      : null
  );
</script>

{#snippet reportRows(rows: DisplayReportRow[])}
  <ul class="space-y-1 text-sm">
    {#each rows as r (r.id)}
      {@const href = entityUrl(civitaiUrl, r.type, r.entityId)}
      <li class="flex flex-wrap items-baseline gap-x-2">
        <Badge variant={reportStatusVariant(r.status)}>{r.status}</Badge>
        <span class="text-dark-0">{reportReasonLabel(r.details, r.reason)}</span>
        {#if href}
          <a {href} target="_blank" rel="noreferrer" class="text-xs {LINK_CLASS}">
            {r.entityType} #{r.entityId}
          </a>
        {/if}
        <span class="text-xs text-dark-2">
          {#if r.reporter}by {r.reporter} · {/if}{dateTime(r.createdAt)}
          {#if r.statusSetBy}· {r.status.toLowerCase()} by {r.statusSetBy}{/if}
        </span>
      </li>
    {/each}
  </ul>
{/snippet}

<div class="mb-4">
  <h3 class="mb-2 text-xs tracking-wide text-dark-2 uppercase">
    Strikes ({atLeast(strikes.length, truncated.strikes)})
  </h3>
  <!-- One store since the 2026-08-21 import: every Retool-era strike is a `UserStrike` row and shows
       in the list above. There is no "plus N elsewhere" left to say. -->
  <StrikeList {strikes} empty="No strikes on this account." />
</div>

<div class="mb-4 grid gap-4 sm:grid-cols-2">
  <div>
    <h3 class="mb-2 text-xs tracking-wide text-dark-2 uppercase">
      Moderation activity ({atLeast(activityRows.length + retoolActivity.length, truncated.activity)})
    </h3>
    {#if activityRows.length === 0 && retoolActivity.length === 0}
      <p class="text-sm text-dark-2">
        {ratingActivity.length > 0
          ? 'No enforcement action — only ratings and tagging.'
          : 'Nothing recorded against this account.'}
      </p>
    {:else if activityRows.length === 0}
      <p class="mb-1 text-sm text-dark-2">Nothing since the Retool migration.</p>
    {:else}
      <ul class="space-y-1 text-sm">
        {#each shownActivity as a (a.id)}
          {@const href = entityUrl(civitaiUrl, a.entityType, a.entityId)}
          <li class="flex flex-wrap items-baseline gap-x-2">
            <span class="text-dark-0">{activityLabel(a.activity)}</span>
            <span class="text-xs text-dark-2">
              {#if href}
                <a {href} target="_blank" rel="noreferrer" class={LINK_CLASS}>
                  {a.entityType} #{a.entityId}
                </a>
              {:else}
                {a.entityType}{a.entityId ? ` #${a.entityId}` : ''}
              {/if}
              {#if a.moderatorUsername}· {a.moderatorUsername}{/if}
              · {dateTime(a.createdAt)}
            </span>
          </li>
        {/each}
      </ul>
    {/if}

    <!-- Not interleaved: Retool rows carry a display name, no moderator id and no entity link. -->
    {#if shownRetool.length}
      <ul class="mt-1 space-y-1 text-sm">
        {#each shownRetool as a (`retool-${a.id}`)}
          <li class="flex flex-wrap items-baseline gap-x-2">
            <span class="text-dark-0">{a.action ?? 'action'}</span>
            <span class="text-xs text-dark-2">
              Retool{#if a.app} · {a.app}{/if}{#if a.moderator} · {a.moderator}{/if}
              · {dateTime(a.at)}
            </span>
          </li>
        {/each}
      </ul>
    {/if}

    <div class="mt-1 flex flex-wrap gap-x-3 text-xs">
      {#if activityHidden > 0 || expandActivity}
        <button type="button" class={LINK_CLASS} onclick={() => (expandActivity = !expandActivity)}>
          {expandActivity
            ? 'Show fewer'
            : `Show all (${atLeast(activityHidden, truncated.activity)} more)`}
        </button>
        <!-- Expanding used to end at 'Show fewer' with nothing hidden, which reads as "that is all of
             it" on an account whose history was cut off by the query. -->
        {#if truncated.activity}
          <span class="text-xs text-dark-2">Older activity beyond this is not shown.</span>
        {/if}
      {/if}
      {#if ratingActivity.length > 0}
        <button type="button" class={LINK_CLASS} onclick={() => (showRatings = !showRatings)}>
          {showRatings ? 'Hide' : 'Show'} rating & tagging ({ratingActivity.length})
        </button>
      {/if}
    </div>
  </div>

  <div>
    <h3 class="mb-2 text-xs tracking-wide text-dark-2 uppercase">
      Account reports ({atLeast(reportsOnUser.length, truncated.reports)}, human-filed)
    </h3>
    {#if reportsOnUser.length === 0}
      <p class="text-sm text-dark-2">No prior report against the account itself.</p>
    {:else}
      {@render reportRows(reportsOnUser.slice(0, PREVIEW))}
    {/if}
  </div>

  <div class="sm:col-span-2">
    <!-- Human-filed only: Automated is ~99.9% of this table on a flagged account. -->
    <h3 class="mb-2 text-xs tracking-wide text-dark-2 uppercase">
      Reports on their content (human-filed)
    </h3>
    <!-- No-JS render shows the heading and nothing under it, rather than a spinner for a fetch that
         was never issued. -->
    {#if contentReports}
      {#await contentReports}
        <p class="text-sm text-dark-2">Loading reports on their content…</p>
      {:then rows}
        {#if rows.length === 0}
          <p class="text-sm text-dark-2">Nothing human-filed against their content.</p>
        {:else}
          {@render reportRows(rows)}
          <a href={userLookupUrl(userId, 'reports')} class="mt-1 inline-block text-xs {LINK_CLASS}">
            All of their reports in User Lookup
          </a>
        {/if}
      {:catch}
        <p class="text-sm text-dark-2">
          Could not load reports on their content —
          <a href={userLookupUrl(userId, 'reports')} class={LINK_CLASS}>see User Lookup</a>.
        </p>
      {/await}
    {/if}
  </div>
</div>

<div class="mb-4">
  <h3 class="mb-2 text-xs tracking-wide text-dark-2 uppercase">Notes ({notes.length})</h3>
  {#if notes.length === 0}
    <p class="text-sm text-dark-2">No notes on this account.</p>
  {:else}
    <ul class="space-y-1 text-sm">
      {#each notes.slice(0, 5) as n (n.id)}
        <li class="min-w-0">
          <p class="wrap-break-word whitespace-pre-wrap text-dark-0">{n.notes}</p>
          <span class="text-xs text-dark-2">
            {n.lastUpdateBy ?? 'unknown'} · {dateTime(n.lastUpdate)}
          </span>
        </li>
      {/each}
    </ul>
    {#if notes.length > 5}
      <a href={userLookupUrl(userId, 'notes')} class="mt-1 inline-block text-xs {LINK_CLASS}">
        All {notes.length} notes
      </a>
    {/if}
  {/if}
</div>
