<script lang="ts">
  import { onMount } from 'svelte';
  import { browser } from '$app/environment';
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
  import { entityUrl, userLookupUrl } from '$lib/entity-url';
  import { LINK_CLASS } from '$lib/format';
  import { sidebarCounts } from '$lib/sidebar-counts.svelte';
  import { queueSeverityClass } from '$lib/queue-thresholds';
  import { writeEnhancer } from '$lib/form-action';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  const name = $derived(data.user?.username ?? 'moderator');
  const counts = sidebarCounts();

  type Reported = {
    id: number;
    reason: string;
    createdAt: string;
    reportCount: number;
    entity: 'image' | 'model' | 'post' | 'article' | 'reportedUser' | 'other';
    entityId: number | null;
    reportedByUsername: string | null;
  };

  // Fetched client-side for the same reason as the sidebar counts: the query joins six report tables and
  // runs ~200ms, which does not belong in the dashboard's first paint.
  let reported = $state<Reported[] | null>(null);

  // Retool's board: who last worked each queue, how far behind each swept task is, and the scam
  // detector's own mutes. A count alone cannot tell an untouched queue from one being drained.
  type Board = {
    activity: Record<string, { type: string; at: string; moderator: string | null }>;
    lag: { task: string; label: string; lastUpdate: string; lastUpdateBy: string | null }[];
    sweeps: { task: string; since: string | null; count: number }[];
    autoBlocked: {
      id: number;
      userId: number;
      username: string | null;
      createdAt: string;
      bannedAt: string | null;
      muted: boolean | null;
    }[];
  };
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

  onMount(async () => {
    try {
      const r = await fetch('/api/most-reported');
      reported = r.ok ? await r.json() : [];
    } catch {
      reported = [];
    }
  });

  const contentUrl = (row: Reported) => entityUrl(data.civitaiUrl, row.entity, row.entityId);

  const age = (iso: string) => {
    const hours = Math.floor((Date.now() - new Date(iso).getTime()) / 3_600_000);
    if (hours < 1) return 'just now';
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  };

  // Mod queries are slow (~200ms), so resolved rows are dimmed in place rather than refetched — and kept
  // rather than removed, so you can see what you just did. Cleared on reload.
  let outcome = $state<Record<number, 'Actioned' | 'Unactioned' | 'failed'>>({});

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
    Object.values(b.activity).sort((a, c) => new Date(a.at).getTime() - new Date(c.at).getTime());

  // Refetches the board rather than invalidating: the swept count lives behind /api/moderation-board,
  // which `load` does not touch.
  const onSweep = writeEnhancer({ onSuccess: () => (boardVersion += 1) });

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
      count: link.countKey ? (counts.value?.[link.countKey] ?? 0) : null,
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

{#if loading}
  <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
    {#each { length: 4 } as _, i (i)}
      <div class="h-40 animate-pulse rounded-xl border border-dark-4 bg-dark-6"></div>
    {/each}
  </div>
{:else}
  <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
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
  <div class="mt-8 rounded-md border border-red-500/30 bg-red-500/10 p-2 text-sm text-red-300" role="alert">
    {form.error}
  </div>
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
        <p class="mb-3 text-xs text-dark-2">Last report resolved in each queue.</p>
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
        {#each board.sweeps as s (s.task)}
          <div class="mt-3 border-t border-dark-4 pt-3">
            <div class="flex flex-wrap items-baseline justify-between gap-2">
              <span class="text-sm text-dark-0">
                {s.task === 'blockedImages' ? 'Unusually blocked images' : 'Official-account models'}
              </span>
              <span class="text-sm tabular-nums {queueSeverityClass(s.task, s.since ? s.count : null) ?? (s.count ? 'text-white' : 'text-dark-2')}">
                {s.since ? format(s.count) : 'never swept'}
              </span>
            </div>
            <form method="POST" action="?/sweep" use:enhance={onSweep} class="mt-1">
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

<h2 class="mt-8 mb-1 text-base font-semibold text-white">Most reported</h2>
<p class="mb-3 text-sm text-dark-2">
  Pending reports from the last week with more than one reporter, worst first. Already-blocked images are
  excluded. Resolving closes the <em>report</em> — it does not remove the content.
</p>

{#if reported === null}
  <div class="h-24 animate-pulse rounded-xl border border-dark-4 bg-dark-6"></div>
{:else if reported.length === 0}
  <section class="rounded-xl border border-dark-4 bg-dark-6 p-5">
    <p class="text-sm text-dark-2">
      Nothing is piling up — no content has drawn more than one report in the last week.
    </p>
  </section>
{:else}
  <div class="overflow-x-auto">
    <Table>
      <TableHeader>
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
          {@const done = outcome[row.id]}
          <TableRow class={done && done !== 'failed' ? 'opacity-40' : undefined}>
            <TableCell><Badge variant="secondary">{row.reportCount}</Badge></TableCell>
            <TableCell>
              {#if contentUrl(row)}
                <a
                  href={contentUrl(row)}
                  target="_blank"
                  rel="noreferrer"
                  class="text-blue-4 hover:underline"
                >
                  {row.entity} {row.entityId}
                </a>
              {:else}
                <span class="text-dark-2">{row.entity} {row.entityId ?? ''}</span>
              {/if}
            </TableCell>
            <TableCell class="text-sm">{row.reason}</TableCell>
            <TableCell class="text-sm whitespace-nowrap">{age(row.createdAt)}</TableCell>
            <TableCell class="text-sm">{row.reportedByUsername ?? '—'}</TableCell>
            <TableCell>
              {#if done === 'failed'}
                <span class="text-sm whitespace-nowrap text-red-400">failed — retry</span>
              {:else if done}
                <span class="text-sm whitespace-nowrap text-dark-2">
                  {done === 'Actioned' ? 'actioned' : 'dismissed'}
                </span>
              {:else}
                <div class="flex gap-1.5">
                  {#each [{ status: 'Actioned', label: 'Actioned' }, { status: 'Unactioned', label: 'Dismiss' }] as choice (choice.status)}
                    <form
                      method="POST"
                      action="?/actionReport"
                      use:enhance={() => {
                        outcome = { ...outcome, [row.id]: choice.status as 'Actioned' | 'Unactioned' };
                        return async ({ result }) => {
                          // Only the row's own state changes — no invalidateAll, which would rerun every
                          // load on the page for a change nothing else reads.
                          if (result.type !== 'success')
                            outcome = { ...outcome, [row.id]: 'failed' };
                        };
                      }}
                    >
                      <input type="hidden" name="id" value={row.id} />
                      <input type="hidden" name="status" value={choice.status} />
                      <Button
                        type="submit"
                        size="sm"
                        variant={choice.status === 'Actioned' ? 'default' : 'outline'}
                      >
                        {choice.label}
                      </Button>
                    </form>
                  {/each}
                </div>
              {/if}
            </TableCell>
          </TableRow>
        {/each}
      </TableBody>
    </Table>
  </div>
{/if}
