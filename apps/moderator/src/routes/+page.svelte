<script lang="ts">
  import { onMount } from 'svelte';
  import { browser } from '$app/environment';
  import { SSR_PENDING } from '$lib/ssr-pending';
  import { navCount, navHref, navPartial } from '$lib/nav-links';
  import { page } from '$app/state';
  import { enhance } from '$app/forms';
  import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
  } from '@civitai/ui/components/ui/table/index.js';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { postReportUrl, userReportUrl } from '$lib/entity-url';
  import {
    getReportItemUrl,
    reportDetailEntries,
    reportEntityLabels,
    MAX_REPORT_DECISIONS,
    MOST_REPORTED_PAGE_SIZE,
    ReportEntity,
  } from '$lib/reports';
  import type { Jsonified } from '$lib/format';
  import type { MostReportedRow } from '$lib/server/reports.service';
  import type { BoardPayload } from './api/moderation-board/types';
  import type { JobQueueHealthPayload } from './api/job-queue-health/types';
  import JobQueueHealthPanel from './JobQueueHealthPanel.svelte';
  import { LINK_CLASS } from '$lib/format';
  import { SvelteMap } from 'svelte/reactivity';
  import NumberedPager from '$lib/components/NumberedPager.svelte';
  import OwnerFlaggedMinorBadge from '$lib/components/minor-flags/OwnerFlaggedMinorBadge.svelte';
  import { sidebarCounts, sidebarLastActioned } from '$lib/sidebar-counts.svelte';
  import {
    URGENT_REPORT_COUNT,
    ageSeverityClass,
    queueSeverityClass,
  } from '$lib/queue-thresholds';
  import { needsAttention, type AttentionItem } from '$lib/needs-attention';
  import { minuteClock } from '$lib/minute-clock.svelte';
  import ShortAge from '$lib/components/ShortAge.svelte';
  import NeedsAttentionPanel from './NeedsAttentionPanel.svelte';
  import { keepLast } from '$lib/keep-last.svelte';
  import type { ModPresencePayload } from './api/mod-presence/types';
  import { FormState } from '$lib/form-state.svelte';
  import type { ActionData, PageData } from './$types';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  // Rendered as text. The link beside it is `data.returnTo`, which the server validated as a path on
  // this app, so a hand-edited `?denied=` cannot turn the dashboard into a jumping-off point elsewhere.
  const denied = $derived(page.url.searchParams.get('denied'));

  const name = $derived(data.user?.username ?? 'moderator');
  const counts = sidebarCounts();

  type Reported = Jsonified<MostReportedRow>;

  // Fetched client-side for the same reason as the sidebar counts: the query joins six report tables and
  // runs ~200ms, which does not belong in the dashboard's first paint.
  //
  // A PAGE of it, ten at a time, and re-read on every page turn — the list is uncached server-side, so
  // what it shows is what the database says rather than a snapshot taken up to a minute ago.
  type MostReported = {
    items: Reported[];
    totalItems: number;
    urgent: number;
    worst: number;
    page: number;
    limit: number;
  };
  let mostReported = $state<MostReported | null>(null);
  const reported = $derived(mostReported?.items ?? null);
  let reportPage = $state(1);

  let reportsLoading = $state(true);

  const loadMostReported = async () => {
    reportsLoading = true;
    try {
      const r = await fetch(`/api/most-reported?page=${reportPage}`);
      mostReported = r.ok ? await r.json() : { items: [], totalItems: 0, urgent: 0, worst: 0, page: 1, limit: MOST_REPORTED_PAGE_SIZE };
    } catch {
      mostReported = { items: [], totalItems: 0, urgent: 0, worst: 0, page: 1, limit: MOST_REPORTED_PAGE_SIZE };
    } finally {
      reportsLoading = false;
    }
  };

  // The models the owner asked to have re-reviewed. Its own fetch because the count has no index and
  // runs ~2.7s — see the service. The page that works them is the main app's, so this is the signal to
  // go there rather than a queue to build twice.
  let modelsReview = $state<number | null>(null);
  $effect(() => {
    fetch('/api/models-review-count')
      .then((r) => (r.ok ? r.json() : { count: null }))
      .then((d) => (modelsReview = d.count))
      .catch(() => (modelsReview = null));
  });

  // A ternary held two of these; a fourth would have made it unreadable and a fifth would have made
  // one of them silently wrong.
  const SWEEP_LABELS: Record<string, string> = {
    blockedImages: 'Unusually blocked images',
    civitaiModels: 'Official-account models',
    articles: 'New articles',
    bounties: 'New bounties',
  };

  // Retool's "Urgent Content (N)" banner — a pile-up on one item is a live incident, not a long queue,
  // stated at the top because the table sits below Needs attention.
  //
  // Counted server-side over the whole window, not over the page on screen: paging past the worst ones
  // is exactly when this must not go quiet.
  const urgentCount = $derived(mostReported?.urgent ?? 0);

  // Retool's board: who last worked each queue, how far behind each swept task is, and the scam
  // detector's own mutes. A count alone cannot tell an untouched queue from one being drained.
  type Board = BoardPayload;
  // Derived rather than fetched into $state, so `boardVersion` can refetch it: "Mark swept" changes
  // data this endpoint owns, and `invalidateAll` would only refresh `load`, which the board never reads.
  let boardVersion = $state(0);
  const board = $derived.by(() => {
    boardVersion;
    if (!browser) return null;
    return fetch('/api/moderation-board').then((r): Promise<Board> => {
      if (!r.ok) throw new Error(`board ${r.status}`);
      return r.json();
    });
  });

  const jobQueue = $derived(
    browser
      ? fetch('/api/job-queue-health').then((r): Promise<JobQueueHealthPayload> => {
          if (!r.ok) throw new Error(`job-queue-health ${r.status}`);
          return r.json();
        })
      : SSR_PENDING
  );

  const lastActioned = sidebarLastActioned();
  const clock = minuteClock();

  const oldest = $derived(
    browser
      ? fetch('/api/queue-oldest').then((r): Promise<Record<string, string>> => {
          if (!r.ok) throw new Error(`queue-oldest ${r.status}`);
          return r.json();
        })
      : SSR_PENDING
  );

  // Refetched on the clock: "working now" is the one panel whose claim expires. keepLast so the
  // refetch does not blank it every minute.
  const presence = keepLast(() => {
    if (!browser) return null;
    void clock.now;
    return fetch('/api/mod-presence').then((r): Promise<ModPresencePayload> => {
      if (!r.ok) throw new Error(`mod-presence ${r.status}`);
      return r.json();
    });
  });

  onMount(loadMostReported);

  // `getReportItemUrl`, not `entityUrl`: a chat has no page on the site (its transcript is Chat Audit,
  // in this app) and a comment hangs off a parent, so neither is derivable from the entity id.
  // 'other' is what `Report` looks like when it joins none of the report tables — the row it
  // named is gone, or was never written. "unknown" read as a rendering bug rather than a fact about
  // the report, which is what the mod team asked about.
  const entityLabel = (row: Reported) =>
    row.entity === 'other' ? 'no linked content' : reportEntityLabels[row.entity];

  const UNLINKED_HINT =
    'This report is not attached to any content — no row exists in any report table for it. Nothing to open.';

  // An unlinked row has no content to open, so the reporter's own fields are the only thing left to
  // rule on. Every other row links to the thing itself, where the details are already shown.
  const unlinkedDetails = (row: Reported) =>
    row.entity === 'other' ? reportDetailEntries(row.details) : [];

  const contentUrl = (row: Reported) =>
    row.entity === 'other'
      ? null
      : getReportItemUrl(data.civitaiUrl, row.entity, row.entityId, row.contextUrl);

  // Every page this moderator can open. `data.nav` is already pruned by `navForUser`, so this is the
  // authority — a deep link into a queue they cannot reach is worse than the site link it replaces.
  const reachable = $derived(
    new Set(
      data.nav
        .flatMap((l) => [l.path, ...(l.children ?? []).map((c) => c.path)])
        .filter((p): p is string => !!p)
    )
  );

  /**
   * A reported ACCOUNT or POST opens the queue that rules on it, not the thing on the site — the
   * moderator's next action is a verdict, and the site page has no verdict on it. Everything else keeps
   * the site link, because that is where the content is judged.
   */
  const queueUrl = (row: Reported): string | null => {
    if (row.entityId === null) return null;
    // `ReportEntity.User` is the string `reportedUser`, not `user` — the enum key and its value differ
    // for exactly this one entity.
    if (row.entity === ReportEntity.User && reachable.has('/reports/user'))
      return userReportUrl(row.entityId);
    if (row.entity === ReportEntity.Post && reachable.has('/reports/post'))
      return postReportUrl(row.entityId);
    return null;
  };

  const age = (iso: string) => {
    const hours = Math.floor((Date.now() - new Date(iso).getTime()) / 3_600_000);
    if (hours < 1) return 'just now';
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  };

  /**
   * Marked, not written. Each click marks the row; nothing reaches the database until Save, which
   * applies the lot in one request and re-reads the list.
   *
   * That is the fix for what the mod team reported, not just an ergonomic one: a per-row write left
   * every other row on screen describing a list the server had already moved on from, so the state a
   * moderator saw after acting depended on when they happened to reload.
   */
  const staged = new SvelteMap<number, 'Actioned' | 'Unactioned'>();

  // Clicking the mark a row already carries takes it off — otherwise the only way out of a misclick on
  // a destructive verdict is discarding the whole page's work.
  const stage = (id: number, status: 'Actioned' | 'Unactioned') => {
    if (staged.get(id) === status) staged.delete(id);
    else staged.set(id, status);
  };

  const decisions = $derived([...staged].map(([id, status]) => `${id}:${status}`).join(','));
  const overDecisionCap = $derived(staged.size > MAX_REPORT_DECISIONS);

  // Marks survive a page turn: ten rows is not a unit of work, and a moderator reading down the list
  // should not have to stop and save at every boundary.
  type SaveResult = { changed: number; unchanged: number; failed: { id: number; error: string }[] };
  let saveResult = $state<SaveResult | null>(null);

  // Reports the SERVER's answer, not the request: a save whose rows were already resolved by someone
  // else changed fewer than were marked, and echoing the count that was sent would confirm work that
  // did not happen.
  const onSaveReports = new FormState({
    onSuccess: async (data) => {
      saveResult = data as SaveResult;
      staged.clear();
      await loadMostReported();
    },
  });

  const turnPage = async (to: number) => {
    reportPage = to;
    await loadMostReported();
  };

  const loading = $derived(counts.value === null);

  // Newest first, as the title reads; stale queues surface in Needs attention instead.
  const recentlyWorked = (b: Board) =>
    [...b.activity].sort((a, c) => new Date(c.at).getTime() - new Date(a.at).getTime());

  // Refetches the board rather than invalidating: the swept count lives behind /api/moderation-board,
  // which `load` does not touch.
  const onSweep = new FormState({ onSuccess: () => (boardVersion += 1) });


  // Every queue the viewer can open, as one list: a tabs group counts as one queue, as in the sidebar.
  const attentionItems = $derived.by((): AttentionItem[] => {
    const countFor = (key: string | undefined) => (key ? (counts.value?.[key] ?? null) : null);
    const toItem = (link: (typeof data.nav)[number], section: string): AttentionItem => ({
      section,
      path: navHref(link) as string,
      label: link.label,
      informational: link.informational,
      count: link.tabs ? navCount(link, countFor) : countFor(link.countKey),
      countKey: link.countKey,
      partial: navPartial(link, (key) => counts.unavailable.includes(key)),
    });
    return data.nav.flatMap((link) =>
      link.children
        ? link.children.filter((c) => c.path && !c.external && !c.shortcut).map((c) => toItem(c, link.label))
        : link.path && link.path !== '/'
          ? [toItem(link, 'Pages')]
          : []
    );
  });
  const attention = $derived(loading ? null : needsAttention(attentionItems, lastActioned.value));

  // One row per catch-up queue: when it was last caught up, and for the queues that count arrivals,
  // how many since. Never-caught-up queues first, then oldest.
  type CatchUpRow = {
    task: string;
    label: string;
    lastUpdate: string | null;
    lastUpdateBy: string | null;
    sweep: Board['sweeps'][number] | null;
  };
  const catchUpRows = (b: Board): CatchUpRow[] => {
    const rows = new Map<string, CatchUpRow>(
      b.lag.map((t) => [
        t.task,
        {
          task: t.task,
          label: SWEEP_LABELS[t.task] ?? t.label,
          lastUpdate: t.lastUpdate,
          lastUpdateBy: t.lastUpdateBy,
          sweep: null,
        },
      ])
    );
    for (const s of b.sweeps) {
      const row = rows.get(s.task);
      if (row) row.sweep = s;
      else
        rows.set(s.task, {
          task: s.task,
          label: SWEEP_LABELS[s.task] ?? s.task,
          lastUpdate: null,
          lastUpdateBy: null,
          sweep: s,
        });
    }
    const at = (r: CatchUpRow) => (r.lastUpdate ? Date.parse(r.lastUpdate) : -Infinity);
    return [...rows.values()].sort((x, y) => at(x) - at(y));
  };

  const MOST_REPORTED_PREVIEW = 5;
  let showAllReported = $state(false);
  const reportedRows = $derived(
    reported && !showAllReported ? reported.slice(0, MOST_REPORTED_PREVIEW) : reported
  );

  const format = (n: number) => n.toLocaleString();
</script>

<header class="flex flex-wrap items-center gap-x-3 gap-y-1.5">
  <h1 class="m-0 text-xl font-semibold text-white">Dashboard</h1>
  <span class="sr-only">Signed in as {name}.</span>
  {#each data.roles as role (role)}
    <span class="rounded bg-blue-8/15 px-2 py-0.5 text-xs font-medium text-blue-4">{role}</span>
  {/each}
  {#if presence.value}
    {@const p = presence.value}
    {@const working = p.working.filter((w) => w.active).length}
    <span class="ml-auto flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-dark-2">
      <span>You today: <strong class="text-white tabular-nums">{p.today.actions}</strong> actions</span>
      <span class="flex items-center gap-1.5">
        <span
          class="size-2 rounded-full {working ? 'bg-green-400' : 'bg-dark-3'}"
          aria-hidden="true"
        ></span>
        {working} working now
      </span>
    </span>
  {/if}
</header>

{#if denied}
  <div
    class="mt-4 rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-2 text-sm text-amber-200"
    role="alert"
  >
    You don't have access to <code>{denied}</code>, so you were sent here. An admin can grant it on the
    Permissions page.
    {#if data.returnTo}
      Once granted, <a class="underline hover:text-amber-100" href={data.returnTo}>try it again</a>.
    {/if}
  </div>
{/if}

{#if urgentCount > 0}
  <a
    href="#most-reported"
    class="mt-4 flex flex-wrap items-center justify-between gap-2 rounded-md border border-red-500/40 bg-red-500/10 px-4 py-2 text-sm text-red-200"
  >
    <span>
      <strong>Urgent content ({urgentCount})</strong>
      — {urgentCount === 1 ? 'one item has' : `${urgentCount} items have`}
      {URGENT_REPORT_COUNT}+ open reports in the last week, worst at {mostReported?.worst ?? 0}.
    </span>
    <span class="underline">Review below</span>
  </a>
{/if}

<div class="mt-4 grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
  <NeedsAttentionPanel
    rows={attention}
    lastActioned={lastActioned.value}
    {oldest}
    now={clock.now}
  />

  <div class="flex flex-col gap-4">
    <section class="rounded-xl border border-dark-4 bg-dark-6 p-4">
      <h2 class="mb-1 text-sm font-semibold text-white">Working now</h2>
      <p class="mb-3 text-xs text-dark-2">
        Green: an action in the last 15 minutes. Otherwise the last moderators on.
      </p>
      {#if presence.value}
        {@const p = presence.value}
        {#if p.working.length === 0}
          <p class="text-sm text-dark-2">No moderator activity in the last two days.</p>
        {:else}
          <ul class="space-y-1.5 text-sm">
            {#each p.working as w (w.username ?? w.at)}
              <li class="flex items-baseline gap-2">
                <span
                  class="size-2 shrink-0 self-center rounded-full {w.active
                    ? 'bg-green-400'
                    : 'bg-dark-3'}"
                  title={w.active ? 'Working now' : 'Not in the last 15 minutes'}
                  aria-hidden="true"
                ></span>
                <span class="text-dark-0">{w.username ?? 'unknown'}</span>
                <span class="min-w-0 flex-1 truncate text-dark-2">{w.label}</span>
                <ShortAge at={w.at} now={clock.now} class="text-xs text-dark-2" />
              </li>
            {/each}
          </ul>
        {/if}
      {:else if presence.failed}
        <p class="text-sm text-red-300">Could not load who is working.</p>
      {:else}
        <div class="h-16 animate-pulse rounded bg-dark-5"></div>
      {/if}
    </section>

    <section class="rounded-xl border border-dark-4 bg-dark-6 p-4">
      <h2 class="mb-3 text-sm font-semibold text-white">You today</h2>
      {#if presence.value}
        {@const p = presence.value}
        <dl class="grid grid-cols-3 gap-2">
          {#each [{ label: 'actions', value: p.today.actions }, { label: 'reports actioned', value: p.today.actioned }, { label: 'reports dismissed', value: p.today.dismissed }] as stat (stat.label)}
            <div class="rounded-lg bg-dark-5 p-2.5">
              <dd class="text-xl font-semibold text-white tabular-nums">{stat.value}</dd>
              <dt class="text-xs text-dark-2">{stat.label}</dt>
            </div>
          {/each}
        </dl>
        <p class="mt-2 text-xs text-dark-2">Since midnight UTC.</p>
      {:else if presence.failed}
        <p class="text-sm text-red-300">Could not load your activity.</p>
      {:else}
        <div class="h-16 animate-pulse rounded bg-dark-5"></div>
      {/if}
    </section>
  </div>
</div>

<!-- Below Needs attention: at full height it kept every queue off screen. -->
<header class="mt-6 mb-1 flex flex-wrap items-baseline justify-between gap-2">
  <h2 id="most-reported" class="scroll-mt-4 text-base font-semibold text-white">Most reported</h2>
  {#if (mostReported?.totalItems ?? 0) > MOST_REPORTED_PREVIEW}
    <button
      type="button"
      class="text-sm {LINK_CLASS}"
      onclick={async () => {
        showAllReported = !showAllReported;
        if (!showAllReported && reportPage !== 1) await turnPage(1);
      }}
    >
      {showAllReported ? `Show top ${MOST_REPORTED_PREVIEW}` : `Show all (${mostReported?.totalItems})`}
    </button>
  {/if}
</header>
<p class="mb-2 text-xs text-dark-2">
  Pending reports from the last week with more than one reporter, worst first; blocked images excluded.
  Resolving closes the <em>report</em>, not the content.
</p>

{#if saveResult}
  <div
    class="mb-3 rounded-md border border-green-500/30 bg-green-500/10 p-2 text-sm text-green-200"
    role="status"
  >
    Saved {saveResult.changed} {saveResult.changed === 1 ? 'decision' : 'decisions'}.
    {#if saveResult.unchanged}
      {saveResult.unchanged} already had the status you set.
    {/if}
    {#if saveResult.failed.length}
      <!-- Named, not counted: a moderator who marked ten reports cannot otherwise tell which of them
           still needs looking at. -->
      <span class="text-amber-300">
        {saveResult.failed.length} could not be saved — {saveResult.failed
          .map((f) => `#${f.id}: ${f.error}`)
          .join('; ')}
      </span>
    {/if}
  </div>
{/if}

{#if staged.size > 0}
  <!-- Above the table: the marks are made reading down it, and a save button only underneath is how a
       page of decisions gets left behind unsaved. Marks survive a page turn, so this stays put. -->
  <form
    method="POST"
    action="?/saveReports"
    use:enhance={onSaveReports.enhance}
    class="mb-3 flex flex-wrap items-center gap-3 rounded-md border border-blue-500/40 bg-blue-500/5 px-4 py-2"
  >
    <input type="hidden" name="decisions" value={decisions} />
    <span class="text-sm text-white"><strong>{staged.size}</strong> marked, not yet saved</span>
    {#if overDecisionCap}
      <span class="text-sm text-red-300">
        Save before marking more — {MAX_REPORT_DECISIONS} at a time.
      </span>
    {/if}
    <div class="ml-auto flex gap-2">
      <Button type="submit" size="sm" disabled={onSaveReports.submitting || overDecisionCap}>
        {onSaveReports.submitting ? 'Saving…' : `Save ${staged.size}`}
      </Button>
      <Button type="button" size="sm" variant="outline" onclick={() => staged.clear()}>
        Discard marks
      </Button>
    </div>
  </form>
{/if}

<!-- Fixed height once paged: rows vary several-fold in height — an unlinked report renders its
     details inline — and a page turn empties the list for as long as the query takes, so a box sized
     to its contents moves the pager under the cursor mid-click. -->
<div
  class="overflow-auto rounded-xl border border-dark-4 bg-dark-6 {showAllReported
    ? 'h-[32rem]'
    : 'min-h-40'}"
>
  {#if reportedRows === null || reportedRows.length === 0}
    <div class="flex h-full min-h-40 flex-col items-center justify-center gap-2 p-5 text-center">
      {#if reportedRows === null}
        <div class="h-6 w-48 animate-pulse rounded bg-dark-5"></div>
        <div class="h-4 w-64 animate-pulse rounded bg-dark-5"></div>
      {:else}
        <p class="text-sm text-white">Nothing is piling up.</p>
        <p class="text-sm text-dark-2">
          No content has drawn more than one report in the last week.
        </p>
      {/if}
    </div>
  {:else}
    <!-- Dimmed rather than emptied while the next page loads: the box keeps its rows so the pager
         below cannot move, and pointer events go so a click cannot land on a row about to be
         replaced. -->
    <div class={reportsLoading ? 'pointer-events-none opacity-50' : undefined}>
    <Table>
      <!-- Sticky inside the scroll box: ten rows do not all fit, and a column header that scrolls away
           leaves the numbers in the first column unlabelled. -->
      <TableHeader class="sticky top-0 z-10 bg-dark-6">
        <TableRow>
          <TableHead class="w-16">Reports</TableHead>
          <TableHead class="w-[38%]">Content</TableHead>
          <TableHead>Reason</TableHead>
          <TableHead>First reported</TableHead>
          <TableHead>By</TableHead>
          <TableHead class="w-px"></TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {#each reportedRows as row (row.id)}
          {@const mark = staged.get(row.id)}
          <TableRow class={mark ? 'opacity-40' : undefined}>
            <TableCell>
              <Badge variant={row.reportCount >= URGENT_REPORT_COUNT ? 'destructive' : 'secondary'}>
                {row.reportCount}
              </Badge>
            </TableCell>
            <TableCell>
              {#if queueUrl(row)}
                <a href={queueUrl(row)} class="text-blue-4 hover:underline">
                  {entityLabel(row)} {row.entityId}
                </a>
              {:else if contentUrl(row)}
                <a
                  href={contentUrl(row)}
                  target="_blank"
                  rel="noreferrer"
                  class="text-blue-4 hover:underline"
                >
                  {entityLabel(row)} {row.entityId}
                </a>
              {:else}
                {@const details = unlinkedDetails(row)}
                <span
                  class="text-dark-2"
                  title={row.entity === 'other' ? UNLINKED_HINT : undefined}
                >
                  {entityLabel(row)} {row.entityId ?? ''}
                </span>
                {#if details.length > 0}
                  <!-- `whitespace-normal` is the load-bearing class. `TableCell` sets
                       `whitespace-nowrap` on every cell and `white-space` inherits, so a detail value
                       could not wrap at ALL — the cell grew to the full length of the text and pushed
                       every column right of it across. Report details are user-submitted free text of
                       no bounded length or shape, and this is the only cell that renders them.
                       `wrap-anywhere` then handles what wrapping alone cannot: production carries a
                       640-character run with no whitespace in it. It is `overflow-wrap: anywhere`, NOT
                       `break-words` — measured, `break-word` does not break that token here, because it
                       only breaks a word that overflows its line box and an auto-layout cell grows
                       instead of overflowing. `anywhere` participates in min-content sizing, so the
                       cell can actually shrink. -->
                  <div class="mt-1 flex min-w-0 flex-col gap-0.5 text-xs whitespace-normal wrap-anywhere text-dark-2">
                    {#each details as [key, value] (key)}
                      <span><span class="font-semibold">{key}:</span> {value}</span>
                    {/each}
                  </div>
                {:else if row.entity === 'other'}
                  <p class="mt-1 text-xs text-dark-2">
                    The reported content is gone and the report carries no details — nothing left to
                    rule on. Dismiss it.
                  </p>
                {/if}
              {/if}
              {#if row.ownerFlaggedMinor}
                <OwnerFlaggedMinorBadge />
              {/if}
            </TableCell>
            <TableCell class="text-sm">{row.reason}</TableCell>
            <TableCell class="text-sm whitespace-nowrap">{age(row.createdAt)}</TableCell>
            <TableCell class="text-sm">{row.reportedByUsername ?? '—'}</TableCell>
            <TableCell>
              <div class="flex justify-end gap-1.5">
                {#each [{ status: 'Actioned', label: 'Actioned' }, { status: 'Unactioned', label: 'Dismiss' }] as choice (choice.status)}
                  <Button
                    size="sm"
                    variant={mark === choice.status
                      ? choice.status === 'Actioned'
                        ? 'destructive'
                        : 'default'
                      : 'outline'}
                    onclick={() => stage(row.id, choice.status as 'Actioned' | 'Unactioned')}
                  >
                    {choice.label}
                  </Button>
                {/each}
              </div>
            </TableCell>
          </TableRow>
        {/each}
      </TableBody>
    </Table>
    </div>
  {/if}
</div>

{#if showAllReported}
  <NumberedPager
    page={mostReported?.page ?? 1}
    total={mostReported?.totalItems ?? 0}
    perPage={MOST_REPORTED_PAGE_SIZE}
    label="reports"
    onPageChange={turnPage}
  />
{/if}

<!-- OUTSIDE the {#await}: bumping boardVersion drops the subtree back to pending, so a
     banner nested inside it vanishes on success and is replaced by the catch branch if the refetch
     then fails — reporting an error for an action that worked. -->
{#if form?.error}
  <ErrorAlert class="mt-6" message={form.error} />
{:else if form && 'swept' in form && form.swept}
  <div class="mt-6 rounded-md border border-green-500/30 bg-green-500/10 p-2 text-sm text-green-200" role="status">
    Marked {form.swept} swept.
  </div>
{/if}

<!-- One fixed height for both, each scrolling inside: side-by-side cards of different heights read
     as unfinished. -->
<div class="mt-6 grid gap-4 lg:grid-cols-2">
  {#await board}
    {#each { length: 2 } as _, i (i)}
      <div class="h-[22rem] animate-pulse rounded-xl border border-dark-4 bg-dark-6"></div>
    {/each}
  {:then loaded}
    {#if loaded}
      {@const worked = recentlyWorked(loaded)}
      {@const rows = catchUpRows(loaded)}
      <section class="flex flex-col rounded-xl border border-dark-4 bg-dark-6 p-4 lg:h-[22rem]">
        <h2 class="mb-1 text-sm font-semibold text-white">Catch-up checks</h2>
        <!-- Retool's task-timer protocol. A row's time is an acknowledgement a moderator wrote ("caught
             up to now"), not a job run — so "3d" means nobody has caught up on it in 3 days. -->
        <p class="mb-2 text-xs text-dark-2">
          Queues reviewed in batches: skim what's new, then mark it caught up. Oldest first.
        </p>
        {#if rows.length}
          <div class="min-h-0 flex-1 overflow-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead class="h-8">Queue</TableHead>
                  <TableHead class="h-8">Last caught up</TableHead>
                  <TableHead class="h-8 text-right">New since</TableHead>
                  <TableHead class="h-8 w-px"><span class="sr-only">Mark caught up</span></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {#each rows as row (row.task)}
                  <TableRow>
                    <TableCell class="text-dark-0">{row.label}</TableCell>
                    <TableCell class="text-xs text-dark-2">
                      {#if row.lastUpdate}
                        <ShortAge
                          at={row.lastUpdate}
                          now={clock.now}
                          class="rounded bg-white/5 px-1 font-semibold tabular-nums {ageSeverityClass(
                            row.lastUpdate,
                            clock.now
                          )}"
                        />{row.lastUpdateBy ? ` · ${row.lastUpdateBy}` : ''}
                      {:else}
                        never
                      {/if}
                    </TableCell>
                    <TableCell class="text-right tabular-nums">
                      {#if row.sweep}
                        <span
                          class={queueSeverityClass(
                            row.task,
                            row.sweep.since ? row.sweep.count : null
                          ) ?? (row.sweep.count ? 'text-white' : 'text-dark-2')}
                        >
                          {row.sweep.since ? format(row.sweep.count) : '—'}
                        </span>
                      {:else}
                        <span class="text-dark-3">—</span>
                      {/if}
                    </TableCell>
                    <TableCell class="text-right">
                      <!-- Only the queues with a since-mark count advance it from here; without the
                           button those counts only ever grow. -->
                      {#if row.sweep}
                        <form method="POST" action="?/sweep" use:enhance={onSweep.enhance}>
                          <input type="hidden" name="task" value={row.task} />
                          <Button type="submit" variant="outline" size="sm" class="h-7 px-2 text-xs">
                            Mark swept
                          </Button>
                        </form>
                      {/if}
                    </TableCell>
                  </TableRow>
                {/each}
              </TableBody>
            </Table>
          </div>
        {:else}
          <p class="text-sm text-dark-2">No catch-up marks recorded.</p>
        {/if}

        {#if modelsReview !== null}
          <p class="mt-3 text-sm" title="Unpublished for a violation, with the owner asking for another look.">
            <a
              href="{data.civitaiUrl}/moderator/models"
              target="_blank"
              rel="noreferrer"
              class={LINK_CLASS}
            >
              Models awaiting re-review ↗
            </a>
            <span
              class="ml-2 tabular-nums {queueSeverityClass('modelsReview', modelsReview) ??
                (modelsReview ? 'text-white' : 'text-dark-2')}"
            >
              {format(modelsReview)}
            </span>
          </p>
        {/if}
      </section>

      <section class="flex flex-col rounded-xl border border-dark-4 bg-dark-6 p-4 lg:h-[22rem]">
        <h2 class="mb-1 text-sm font-semibold text-white">Recently worked</h2>
        <!-- Retool's `RecentReports`: tells a queue nobody is working from one being drained, which a
             count alone cannot. Kept as a list because it covers every kind of work, `ModActivity`
             included; the per-row last-actioned badges (sidebar, Needs attention) only know report
             queues. -->
        <p class="mb-2 text-xs text-dark-2">
          Last report resolved, and last moderator action logged, per kind of work. Newest first.
        </p>
        {#if worked.length}
          <ul class="min-h-0 flex-1 space-y-1 overflow-auto pr-1 text-sm">
            {#each worked as a (a.type)}
              <li class="flex items-baseline justify-between gap-3">
                <span class="min-w-0 truncate text-dark-0">{a.type}</span>
                <span class="shrink-0 text-xs text-dark-2">
                  <ShortAge
                    at={a.at}
                    now={clock.now}
                    class="rounded bg-white/5 px-1 font-semibold tabular-nums {ageSeverityClass(
                      a.at,
                      clock.now
                    )}"
                  />{a.moderator ? ` · ${a.moderator}` : ''}
                </span>
              </li>
            {/each}
          </ul>
        {:else}
          <p class="text-sm text-dark-2">No recent activity recorded.</p>
        {/if}
      </section>
    {/if}
  {:catch}
    <!-- Absence must not read as "every queue is clear": a failed fetch would otherwise be
         indistinguishable from a quiet day. -->
    <p class="text-sm text-red-300 lg:col-span-2">
      Could not load the queue board. The counts above are unaffected.
    </p>
  {/await}
</div>

<!-- Its own await, not folded into the board's: this reads a different table on a different cadence,
     and the board's "Mark swept" refetch must not drop this panel back to a skeleton. -->
<details class="mt-6 rounded-xl border border-dark-4 bg-dark-6 px-4 py-3">
  <summary class="cursor-pointer text-sm text-dark-0">
    Background jobs
    {#await jobQueue}
      <span class="text-dark-2">· loading</span>
    {:then health}
      {#if health}
        <span class={health.overdue ? 'text-amber-300' : 'text-green-400'}>
          · {health.overdue ? `${health.overdue.toLocaleString()} overdue` : 'healthy'}
        </span>
      {/if}
    {:catch}
      <span class="text-red-300">· could not load</span>
    {/await}
  </summary>
  <div class="mt-3">
    {#await jobQueue then health}
      {#if health}
        <JobQueueHealthPanel {health} />
      {/if}
    {:catch}
      <p class="text-sm text-red-300">Could not load background job health.</p>
    {/await}
  </div>
</details>
