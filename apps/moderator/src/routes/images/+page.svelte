<script lang="ts">
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  // Streamed sidebar counts (from the root layout) — badge the hub cards too.
  let counts = $state<Record<string, number> | null>(null);
  $effect(() => {
    data.sidebarCounts?.then((c) => (counts = c)).catch(() => {});
  });
  const countFor = (key: string | undefined) => (key && counts ? (counts[key] ?? null) : null);
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
