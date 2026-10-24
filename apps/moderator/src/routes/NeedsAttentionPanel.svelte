<script lang="ts">
  import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
  } from '@civitai/ui/components/ui/table/index.js';
  import ShortAge from '$lib/components/ShortAge.svelte';
  import { LINK_CLASS } from '$lib/format';
  import { navBadge } from '$lib/nav-links';
  import type { AttentionItem } from '$lib/needs-attention';
  import {
    LAST_ACTIONED_WINDOW_DAYS,
    isOverdue,
    lastActionedBadge,
    queueSeverityClass,
  } from '$lib/queue-thresholds';

  let {
    rows,
    lastActioned,
    oldest,
    now,
  }: {
    /** `null` while the counts load. */
    rows: { over: AttentionItem[]; rest: AttentionItem[] } | null;
    /** `null` until it loads, and then no badge is drawn: a missing time reads as "no action in a week". */
    lastActioned: Record<string, { at: string; by: string | null }> | null;
    oldest: Promise<Record<string, string>>;
    now: number;
  } = $props();

  const BADGE = 'rounded bg-white/5 px-1 text-[11px] font-semibold tabular-nums';

  let showRest = $state(false);
  const shown = $derived(rows ? (showRest ? [...rows.over, ...rows.rest] : rows.over) : []);
  const uncounted = $derived(!!rows && [...rows.over, ...rows.rest].some((r) => r.partial));
  const PARTIAL_TITLE = 'Some counts are unavailable';
</script>

<section class="rounded-xl border border-dark-4 bg-dark-6 p-4">
  <header class="mb-1 flex flex-wrap items-baseline justify-between gap-2">
    <h2 class="text-sm font-semibold text-white">Needs attention</h2>
    <span class="text-xs text-dark-2">
      Every queue over its threshold, worst first, then longest untouched
    </span>
  </header>

  {#if rows === null}
    <div class="space-y-2 py-2">
      {#each { length: 6 } as _, i (i)}
        <div class="h-6 animate-pulse rounded bg-dark-5"></div>
      {/each}
    </div>
  {:else}
    {#if rows.over.length === 0}
      <p class="py-2 text-sm text-dark-2">
        {uncounted
          ? 'Nothing counted is over its threshold. Some counts are unavailable.'
          : rows.rest.length
            ? 'Nothing is over its threshold.'
            : 'Every queue is clear.'}
      </p>
    {/if}
    {#if shown.length}
    <div class="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead class="h-8">Queue</TableHead>
            <TableHead class="h-8 text-right">Waiting</TableHead>
            <TableHead class="h-8">Oldest</TableHead>
            <TableHead class="h-8">Last actioned</TableHead>
            <TableHead class="h-8 w-px"><span class="sr-only">Open</span></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {#each shown as row (row.path)}
            {@const last = row.countKey ? lastActioned?.[row.countKey] : undefined}
            {@const waiting = navBadge(row.count, !!row.partial, (n) => n.toLocaleString())}
            {@const badge = lastActioned
              ? lastActionedBadge(row.countKey, last?.at, row.count, now)
              : null}
            <TableRow>
              <TableCell>
                <span class="text-dark-2">{row.section} ›</span>
                <span class="text-dark-0">{row.label}</span>
              </TableCell>
              <TableCell
                class="text-right font-semibold tabular-nums {(row.countKey &&
                  queueSeverityClass(row.countKey, row.count)) ||
                  'text-white'}"
                title={row.partial ? PARTIAL_TITLE : undefined}
              >
                {waiting?.text}
              </TableCell>
              <TableCell class="text-sm tabular-nums">
                {#await oldest}
                  <span class="text-dark-3">…</span>
                {:then ages}
                  {@const since = row.countKey ? ages[row.countKey] : undefined}
                  {#if since}
                    <ShortAge
                      at={since}
                      {now}
                      title="Oldest waiting since {new Date(since).toLocaleString()}"
                      class={isOverdue(since, now) ? 'font-semibold text-red-300' : 'text-dark-0'}
                    />
                  {:else}
                    <span class="text-dark-3">—</span>
                  {/if}
                {:catch}
                  <span class="text-dark-3">—</span>
                {/await}
              </TableCell>
              <TableCell class="text-sm whitespace-nowrap">
                {#if badge && last}
                  <ShortAge at={last.at} {now} title={badge.title} class="{BADGE} {badge.class}" />
                  {#if last.by}<span class="text-dark-2"> · {last.by}</span>{/if}
                {:else if badge}
                  <span class="{BADGE} {badge.class}" title={badge.title}>
                    &gt;{LAST_ACTIONED_WINDOW_DAYS}d
                  </span>
                {:else}
                  <span class="text-dark-3">—</span>
                {/if}
              </TableCell>
              <TableCell class="text-right">
                <a href={row.path} class={LINK_CLASS}>Open</a>
              </TableCell>
            </TableRow>
          {/each}
        </TableBody>
      </Table>
    </div>
    {/if}
    {#if rows.rest.length}
      <button type="button" class="mt-2 text-sm {LINK_CLASS}" onclick={() => (showRest = !showRest)}>
        {showRest
          ? 'Show only queues over threshold'
          : `+${rows.rest.length} more with work, below threshold`}
      </button>
    {/if}
  {/if}
</section>
