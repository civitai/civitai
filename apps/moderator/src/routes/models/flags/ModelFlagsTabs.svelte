<script lang="ts">
  import { page } from '$app/state';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { cn } from '@civitai/ui/utils.js';
  import { num } from '$lib/format';
  import { isPathActive } from '$lib/nav-links';
  import { sidebarCounts } from '$lib/sidebar-counts.svelte';

  const counts = sidebarCounts();
  const tabs = $derived(page.data.modelFlagTabs ?? []);
</script>

<nav class="flex gap-1 border-b border-dark-4" aria-label="Model Flags">
  {#each tabs as t (t.href)}
    {@const count = t.countKey ? counts.value?.[t.countKey] : undefined}
    <a
      href={t.href}
      aria-current={isPathActive(t.href, page.url.pathname) ? 'page' : undefined}
      class={cn(
        'flex items-center gap-2 rounded-t-md px-4 py-2 text-sm',
        isPathActive(t.href, page.url.pathname)
          ? 'border-b-2 border-blue-500 text-white'
          : 'text-dark-2 hover:text-dark-0'
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
