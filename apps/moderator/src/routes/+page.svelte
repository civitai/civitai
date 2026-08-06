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

  const ENTITY_PATH: Record<string, string> = {
    image: 'images',
    model: 'models',
    post: 'posts',
    article: 'articles',
  };

  const contentUrl = (row: Reported) =>
    row.entityId && ENTITY_PATH[row.entity]
      ? `${data.civitaiUrl}/${ENTITY_PATH[row.entity]}/${row.entityId}`
      : null;

  const age = (iso: string) => {
    const hours = Math.floor((Date.now() - new Date(iso).getTime()) / 3_600_000);
    if (hours < 1) return 'just now';
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  };

  // Mod queries are slow (~200ms), so resolved rows are dimmed in place rather than refetched — and kept
  // rather than removed, so you can see what you just did. Cleared on reload.
  let outcome = $state<Record<number, 'Actioned' | 'Unactioned' | 'failed'>>({});

  type Entry = {
    path: string;
    label: string;
    section: string | null;
    countKey?: string;
    informational?: boolean;
  };

  // Leaves only — a section header is not somewhere you work. `data.nav` is already pruned to this user.
  const entries = $derived.by(() => {
    const out: Entry[] = [];
    const walk = (links: typeof data.nav, section: string | null) => {
      for (const link of links) {
        if (link.children) {
          walk(link.children, link.label);
          continue;
        }
        if (link.path && link.path !== '/')
          out.push({
            path: link.path,
            label: link.label,
            section,
            countKey: link.countKey,
            informational: link.informational,
          });
      }
    };
    walk(data.nav, null);
    return out;
  });

  const loading = $derived(counts.value === null);

  const queues = $derived(
    entries
      .filter((e) => e.countKey && !e.informational)
      .map((e) => ({ ...e, count: counts.value?.[e.countKey as string] ?? 0 }))
      .sort((a, b) => b.count - a.count)
  );

  const pending = $derived(queues.filter((q) => q.count > 0));
  const quiet = $derived([
    ...queues.filter((q) => q.count === 0),
    ...entries.filter((e) => !e.countKey || e.informational),
  ]);

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
    {#each { length: 6 } as _, i (i)}
      <div class="h-24 animate-pulse rounded-xl border border-dark-4 bg-dark-6"></div>
    {/each}
  </div>
{:else if pending.length > 0}
  <h2 class="mb-3 text-base font-semibold text-white">Needs attention</h2>
  <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
    {#each pending as queue (queue.path)}
      <a
        href={queue.path}
        class="rounded-xl border border-dark-4 bg-dark-6 p-5 transition-colors hover:border-blue-8 hover:bg-dark-5"
      >
        <div class="text-2xl font-semibold tabular-nums text-white">{format(queue.count)}</div>
        <div class="mt-1 text-sm text-dark-0">{queue.label}</div>
        {#if queue.section}
          <div class="text-xs text-dark-2">{queue.section}</div>
        {/if}
      </a>
    {/each}
  </div>
{:else}
  <section class="rounded-xl border border-dark-4 bg-dark-6 p-5">
    <h2 class="text-base font-semibold text-white">All clear</h2>
    <p class="mt-1 text-sm text-dark-2">Nothing is waiting in the queues you can reach.</p>
  </section>
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

{#if !loading && quiet.length > 0}
  <h2 class="mt-8 mb-3 text-base font-semibold text-white">Everything else</h2>
  <div class="flex flex-wrap gap-1.5">
    {#each quiet as entry (entry.path)}
      <a href={entry.path} class="rounded bg-dark-7 px-2 py-1 text-xs text-dark-1 hover:text-dark-0">
        {entry.label}
      </a>
    {/each}
  </div>
{/if}
