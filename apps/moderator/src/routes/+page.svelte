<script lang="ts">
  import { sidebarCounts } from '$lib/sidebar-counts.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  const name = $derived(data.user?.username ?? 'moderator');
  const counts = sidebarCounts();

  type Entry = { path: string; label: string; section: string | null; countKey?: string };

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
          out.push({ path: link.path, label: link.label, section, countKey: link.countKey });
      }
    };
    walk(data.nav, null);
    return out;
  });

  const loading = $derived(counts.value === null);

  const queues = $derived(
    entries
      .filter((e) => e.countKey)
      .map((e) => ({ ...e, count: counts.value?.[e.countKey as string] ?? 0 }))
      .sort((a, b) => b.count - a.count)
  );

  const pending = $derived(queues.filter((q) => q.count > 0));
  const quiet = $derived([
    ...queues.filter((q) => q.count === 0),
    ...entries.filter((e) => !e.countKey),
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
          <div class="text-xs text-dark-3">{queue.section}</div>
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
