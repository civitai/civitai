<script lang="ts">
  import { onMount } from 'svelte';
  import { browser } from '$app/environment';
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
  import { userLookupUrl } from '$lib/entity-url';
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
  import { LINK_CLASS } from '$lib/format';
  import { SvelteMap } from 'svelte/reactivity';
  import NumberedPager from '$lib/components/NumberedPager.svelte';
  import { sidebarCounts } from '$lib/sidebar-counts.svelte';
  import { URGENT_REPORT_COUNT, queueSeverityClass } from '$lib/queue-thresholds';
  import { FormState } from '$lib/form-state.svelte';
  import type { ActionData, PageData } from './$types';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  // Only ever a pathname this app redirected from, but rendered as text rather than a link so a
  // hand-edited `?denied=` cannot turn the dashboard into a jumping-off point to somewhere else.
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
  // stated at the top because the table is below three screens of queue counts.
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

  onMount(loadMostReported);

  // `getReportItemUrl`, not `entityUrl`: a chat has no page on the site (its transcript is Chat Audit,
  // in this app) and a comment hangs off a parent, so neither is derivable from the entity id.
  // 'other' is what `Report` looks like when it joins none of the fifteen report tables — the row it
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
    if (row.entity === ReportEntity.User && reachable.has('/retool/user-reports'))
      return `/retool/user-reports?user=${row.entityId}`;
    if (row.entity === ReportEntity.Post && reachable.has('/retool/post-reports'))
      return `/retool/post-reports?post=${row.entityId}`;
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

  // `count: null` = nothing to count (no countKey), which is not the same as an empty queue — the
  // empty-row collapsing below keys off that difference.
  type Item = {
    path: string;
    label: string;
    informational?: boolean;
    count: number | null;
    countKey?: string;
  };
  type Section = { label: string; items: Item[]; total: number };

  const loading = $derived(counts.value === null);

  const severity = (item: Item) =>
    item.countKey ? queueSeverityClass(item.countKey, item.count) : null;

  // Oldest first: the queue nobody has touched is the one worth seeing, not the busiest.
  const recentlyWorked = (b: Board) =>
    [...b.activity].sort((a, c) => new Date(a.at).getTime() - new Date(c.at).getTime());

  // Refetches the board rather than invalidating: the swept count lives behind /api/moderation-board,
  // which `load` does not touch.
  const onSweep = new FormState({ onSuccess: () => (boardVersion += 1) });

  const ago = (iso: string) => {
    const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (mins < 60) return `${Math.max(0, mins)}m ago`;
    if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
    return `${Math.round(mins / 1440)}d ago`;
  };

  const sections = $derived.by(() => {
    const toItem = (link: (typeof data.nav)[number]): Item => ({
      path: link.path as string,
      label: link.label,
      informational: link.informational,
      // `?? null`, not `?? 0`: a key the counts endpoint omitted is one it could not measure, and 0
      // both reads as "empty" and hides the row under the quiet-queue filter.
      count: link.countKey ? (counts.value?.[link.countKey] ?? null) : null,
      countKey: link.countKey,
    });
    const byCount = (a: Item, b: Item) => (b.count ?? -1) - (a.count ?? -1);

    const grouped: Section[] = [];
    const loose: Item[] = [];
    for (const link of data.nav) {
      if (link.children) {
        const items = link.children.filter((c) => c.path && !c.external).map(toItem).sort(byCount);
        grouped.push({
          label: link.label,
          items,
          total: items.reduce((sum, i) => sum + (i.informational ? 0 : (i.count ?? 0)), 0),
        });
      } else if (link.path && link.path !== '/') {
        loose.push(toItem(link));
      }
    }
    if (loose.length) grouped.push({ label: 'Pages', items: loose, total: 0 });
    return grouped;
  });

  let expanded = $state<Record<string, boolean>>({});
  const quietCount = (section: Section) => section.items.filter((i) => i.count === 0).length;
  const visibleItems = (section: Section) =>
    expanded[section.label] ? section.items : section.items.filter((i) => i.count !== 0);

  const format = (n: number) => n.toLocaleString();
</script>

<header class="page-header">
  <h1>Dashboard</h1>
  <p class="flex flex-wrap items-center gap-1.5">
    <span>Welcome back, {name}.</span>
    {#each data.roles as role (role)}
      <span class="rounded bg-blue-8/15 px-2 py-0.5 text-xs font-medium text-blue-4">{role}</span>
    {/each}
  </p>
</header>

{#if denied}
  <div
    class="mt-8 rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-2 text-sm text-amber-200"
    role="alert"
  >
    You don't have access to <code>{denied}</code>, so you were sent here. An admin can grant it on the
    Permissions page.
  </div>
{/if}

{#if urgentCount > 0}
  <a
    href="#most-reported"
    class="mt-8 flex flex-wrap items-center justify-between gap-2 rounded-md border border-red-500/40 bg-red-500/10 px-4 py-2 text-sm text-red-200"
  >
    <span>
      <strong>Urgent content ({urgentCount})</strong>
      — {urgentCount === 1 ? 'one item has' : `${urgentCount} items have`}
      {URGENT_REPORT_COUNT}+ open reports in the last week, worst at {mostReported?.worst ?? 0}.
    </span>
    <span class="underline">Review below</span>
  </a>
{/if}

<!-- Above the queue board, not below it: a pile-up on one item is a live incident and the counts
     are a backlog. The mod team asked for the table itself to lead, not a banner pointing at it. -->
<h2 id="most-reported" class="mt-8 mb-1 scroll-mt-4 text-base font-semibold text-white">
  Most reported
</h2>
<p class="mb-3 text-sm text-dark-2">
  Pending reports from the last week with more than one reporter, worst first — this is the same data
  the urgent-content banner counts, at {URGENT_REPORT_COUNT}+ reports. Already-blocked images are excluded. Resolving closes the <em>report</em> — it does not remove the content.
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

<!-- One box, always this height, whatever is inside it. Rows vary several-fold in height — an
     unlinked report renders its details inline — and a page turn empties the list for as long as the
     query takes, so anything sized to its contents moves the pager under the cursor mid-click. -->
<div class="h-[32rem] overflow-auto rounded-xl border border-dark-4 bg-dark-6">
  {#if reported === null || reported.length === 0}
    <div class="flex h-full flex-col items-center justify-center gap-2 p-5 text-center">
      {#if reported === null}
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
          <TableHead>Content</TableHead>
          <TableHead>Reason</TableHead>
          <TableHead>First reported</TableHead>
          <TableHead>By</TableHead>
          <TableHead class="w-px"></TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {#each reported as row (row.id)}
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
                  <div class="mt-1 flex flex-col gap-0.5 text-xs text-dark-2">
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

<NumberedPager
  page={mostReported?.page ?? 1}
  total={mostReported?.totalItems ?? 0}
  perPage={MOST_REPORTED_PAGE_SIZE}
  label="reports"
  onPageChange={turnPage}
/>

{#if loading}
  <div class="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
    {#each { length: 4 } as _, i (i)}
      <div class="h-40 animate-pulse rounded-xl border border-dark-4 bg-dark-6"></div>
    {/each}
  </div>
{:else}
  <div class="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
    {#each sections as section (section.label)}
      {@const items = visibleItems(section)}
      {@const quiet = quietCount(section)}
      <section class="rounded-xl border border-dark-4 bg-dark-6 p-4">
        <header class="mb-1 flex items-baseline justify-between gap-2">
          <h2 class="text-sm font-semibold text-white">{section.label}</h2>
          {#if section.total > 0}
            <span class="text-sm font-semibold tabular-nums text-blue-4">
              {format(section.total)}
            </span>
          {/if}
        </header>

        {#if items.length === 0}
          <p class="py-1 text-sm text-dark-2">All clear</p>
        {:else}
          <ul>
            {#each items as item (item.path)}
              <li>
                <a
                  href={item.path}
                  class="-mx-1 flex items-center justify-between gap-3 rounded px-1 py-1 text-sm hover:bg-dark-5"
                >
                  <span class={item.count ? 'text-dark-0' : 'text-dark-2'}>{item.label}</span>
                  {#if item.count !== null}
                    <!-- Retool's threshold colouring. The scales are per-queue and not comparable —
                         2 comment reports is amber where 200 tags is still green — so a queue with no
                         standard renders plainly rather than borrowing another's. -->
                    <span
                      class="tabular-nums {severity(item) ??
                        (item.count ? 'text-white' : 'text-dark-2')}"
                    >
                      {format(item.count)}
                    </span>
                  {/if}
                </a>
              </li>
            {/each}
          </ul>
        {/if}

        {#if quiet > 0}
          <button
            type="button"
            class="mt-1 text-xs text-dark-2 hover:text-dark-0"
            onclick={() => (expanded[section.label] = !expanded[section.label])}
          >
            {expanded[section.label] ? 'Hide empty' : `${quiet} empty`}
          </button>
        {/if}
      </section>
    {/each}
  </div>
{/if}

<!-- OUTSIDE the {#await}: bumping boardVersion drops the subtree back to pending, so a
     banner nested inside it vanishes on success and is replaced by the catch branch if the refetch
     then fails — reporting an error for an action that worked. -->
{#if form?.error}
  <ErrorAlert class="mt-8" message={form.error} />
{:else if form && 'swept' in form && form.swept}
  <div class="mt-8 rounded-md border border-green-500/30 bg-green-500/10 p-2 text-sm text-green-200" role="status">
    Marked {form.swept} swept.
  </div>
{/if}

{#await board}
  <div class="mt-8 grid gap-3 lg:grid-cols-3">
    {#each { length: 3 } as _, i (i)}
      <div class="h-32 animate-pulse rounded-xl border border-dark-4 bg-dark-6"></div>
    {/each}
  </div>
{:then loaded}
  {@const board = loaded}
  {@const worked = board ? recentlyWorked(board) : []}
  {#if board}
    <div class="mt-8 grid gap-3 lg:grid-cols-3">
    <!-- Retool's `RecentReports`, which fed the "last touched by <mod> N minutes ago" on every queue
         row. Its point is telling a queue nobody is working from one being actively drained — a count
         alone cannot. Listed rather than attached per row: the report-source labels and the sidebar's
         count keys are named independently, and three of them do not correspond. -->
    {#if worked.length}
      <section class="rounded-xl border border-dark-4 bg-dark-6 p-4">
        <h2 class="mb-1 text-sm font-semibold text-white">Recently worked</h2>
        <p class="mb-3 text-xs text-dark-2">
          Last report resolved, and last moderator action logged, per kind of work.
        </p>
        <ul class="space-y-1 text-sm">
          {#each worked as a (a.type)}
            <li class="flex flex-wrap items-baseline justify-between gap-x-3">
              <span class="text-dark-0">{a.type}</span>
              <span class="text-xs text-dark-2">
                {ago(a.at)}{a.moderator ? ` · ${a.moderator}` : ''}
              </span>
            </li>
          {/each}
        </ul>
      </section>
    {/if}

    <!-- Retool's per-queue lag strip. The rows are acknowledgements a moderator wrote ("I have swept
         this up to now"), not job runs — so "3d ago" means nobody has claimed the queue in 3 days. -->
    {#if board.lag.length}
      <section class="rounded-xl border border-dark-4 bg-dark-6 p-4">
        <h2 class="mb-1 text-sm font-semibold text-white">Queue sweeps</h2>
        <p class="mb-3 text-xs text-dark-2">
          When each queue was last claimed, oldest first. Nothing sweeps automatically.
        </p>
        <ul class="space-y-1 text-sm">
          {#each board.lag as t (t.task)}
            <li class="flex items-baseline justify-between gap-3">
              <span class="text-dark-0">{t.label}</span>
              <span class="text-xs text-dark-2">
                {ago(t.lastUpdate)}{t.lastUpdateBy ? ` · ${t.lastUpdateBy}` : ''}
              </span>
            </li>
          {/each}
        </ul>

        <!-- The two queues whose count is "what has arrived since the mark". Marking swept is what
             advances it; without the button the counts only ever grow. -->
        {#if modelsReview !== null}
          <div class="mt-3 border-t border-dark-4 pt-3">
            <div class="flex flex-wrap items-baseline justify-between gap-2">
              <a
                href="{data.civitaiUrl}/moderator/models"
                target="_blank"
                rel="noreferrer"
                class="text-sm text-blue-4 hover:underline"
              >
                Models awaiting re-review ↗
              </a>
              <span
                class="text-sm tabular-nums {queueSeverityClass('modelsReview', modelsReview) ??
                  (modelsReview ? 'text-white' : 'text-dark-2')}"
              >
                {format(modelsReview)}
              </span>
            </div>
            <p class="mt-1 text-xs text-dark-2">
              Unpublished for a violation, with the owner asking for another look.
            </p>
          </div>
        {/if}

        {#each board.sweeps as s (s.task)}
          <div class="mt-3 border-t border-dark-4 pt-3">
            <div class="flex flex-wrap items-baseline justify-between gap-2">
              <span class="text-sm text-dark-0">{SWEEP_LABELS[s.task] ?? s.task}</span>
              <span class="text-sm tabular-nums {queueSeverityClass(s.task, s.since ? s.count : null) ?? (s.count ? 'text-white' : 'text-dark-2')}">
                {s.since ? format(s.count) : 'never swept'}
              </span>
            </div>
            <form method="POST" action="?/sweep" use:enhance={onSweep.enhance} class="mt-1">
              <input type="hidden" name="task" value={s.task} />
              <Button type="submit" variant="outline" size="sm">Mark swept</Button>
            </form>
          </div>
        {/each}
      </section>
    {/if}

    <!-- Retool's `AutoBlockedUsers`. Nobody decided these individually, so this list is the only place
         a false positive is visible — a muted account with no moderator behind it. -->
    {#if board.autoBlocked.length}
      <section class="rounded-xl border border-dark-4 bg-dark-6 p-4">
        <h2 class="mb-1 text-sm font-semibold text-white">
          Auto-muted for scam ({board.autoBlocked.length}{board.autoBlocked.length === 50 ? '+' : ''})
        </h2>
        <p class="mb-3 text-xs text-dark-2">
          Muted by the detector, not by a moderator. Review the ones that look wrong.
        </p>
        <ul class="space-y-1 text-sm">
          {#each board.autoBlocked.slice(0, 12) as u (u.id)}
            <li class="flex flex-wrap items-baseline justify-between gap-x-3">
              <a href={userLookupUrl(u.userId)} class={LINK_CLASS}>
                {u.username ?? `#${u.userId}`}
              </a>
              <span class="flex items-baseline gap-2 text-xs text-dark-2">
                {#if u.bannedAt}<Badge variant="destructive">banned since</Badge>{/if}
                {#if !u.muted}<Badge variant="secondary">already unmuted</Badge>{/if}
                {ago(u.createdAt)}
              </span>
            </li>
          {/each}
        </ul>
      </section>
    {/if}
    </div>
  {/if}
{:catch}
  <!-- Absence must not read as "every queue is clear": these panels hide themselves when empty, so a
       failed fetch would otherwise be indistinguishable from a quiet day. -->
  <p class="mt-8 text-sm text-red-300">
    Could not load the queue board. The counts above are unaffected.
  </p>
{/await}
