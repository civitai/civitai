<script lang="ts">
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { cn } from '@civitai/ui/utils.js';
  import { num } from '$lib/format';
  import { isPathActive } from '$lib/nav-links';
  import { sidebarCounts } from '$lib/sidebar-counts.svelte';

  let {
    tabs,
    current,
    label,
  }: {
    /** Only the tabs to show; the caller has already dropped the ones the moderator can't open. */
    tabs: { label: string; href: string; countKey?: string }[];
    /** The pathname the page is on. */
    current: string;
    /** Accessible name of the tab bar. */
    label: string;
  } = $props();

  const counts = sidebarCounts();
</script>

<nav class="flex gap-1 border-b border-dark-4" aria-label={label}>
  {#each tabs as t (t.href)}
    {@const count = t.countKey ? counts.value?.[t.countKey] : undefined}
    {@const active = isPathActive(t.href, current)}
    <a
      href={t.href}
      aria-current={active ? 'page' : undefined}
      class={cn(
        'flex items-center gap-2 rounded-t-md px-4 py-2 text-sm',
        active ? 'border-b-2 border-blue-500 text-white' : 'text-dark-2 hover:text-dark-0'
      )}
    >
      {t.label}
      <!-- Absent until loaded: a placeholder 0 reads as "nothing to review". -->
      {#if count !== undefined}
        <Badge variant="secondary">{num(count)}</Badge>
      {/if}
    </a>
  {/each}
</nav>
