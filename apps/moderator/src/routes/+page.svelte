<script lang="ts">
  import { onMount } from 'svelte';
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
  import { entityUrl } from '$lib/entity-url';
  import { sidebarCounts } from '$lib/sidebar-counts.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

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
  type Item = { path: string; label: string; informational?: boolean; count: number | null };
  type Section = { label: string; items: Item[]; total: number };

  const loading = $derived(counts.value === null);

  const sections = $derived.by(() => {
    const toItem = (link: (typeof data.nav)[number]): Item => ({
      path: link.path as string,
      label: link.label,
      informational: link.informational,
      count: link.countKey ? (counts.value?.[link.countKey] ?? 0) : null,
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
                    <span class="tabular-nums {item.count ? 'text-white' : 'text-dark-2'}">
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
