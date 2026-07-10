<script lang="ts">
  import { sidebarCounts } from '$lib/sidebar-counts.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  // Client-fetched sidebar counts (shared with the sidebar) — badge the hub cards too.
  const counts = sidebarCounts();
  const countFor = (key: string | undefined) =>
    key && counts.value ? (counts.value[key] ?? null) : null;
</script>

<header class="page-header">
  <h1>{data.title}</h1>
  <p class="text-sm text-muted-foreground">Pick a review queue.</p>
</header>

<div class="grid gap-3" style="grid-template-columns: repeat(auto-fill, minmax(220px, 1fr))">
  {#each data.links as link (link.path)}
    {@const cnt = countFor(link.countKey)}
    <a
      href={link.path}
      class="flex items-center justify-between gap-2 rounded-lg border border-border p-4 text-sm font-medium transition hover:border-primary hover:bg-muted/50"
    >
      <span>{link.label}</span>
      {#if cnt}
        <span
          class="rounded-full bg-primary/15 px-2 py-0.5 text-xs font-semibold tabular-nums text-primary"
        >
          {cnt}
        </span>
      {/if}
    </a>
  {/each}
</div>
