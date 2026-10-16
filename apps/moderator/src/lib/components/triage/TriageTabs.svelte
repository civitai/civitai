<script lang="ts">
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
    tabs: { label: string; href: string; countKey?: string; hint?: string }[];
    /** The pathname the page is on. */
    current: string;
    /** Accessible name of the tab bar. */
    label: string;
  } = $props();

  const counts = sidebarCounts();
</script>

<nav class="flex gap-2 border-b border-dark-4 px-6" aria-label={label}>
  {#each tabs as t (t.href)}
    {@const count = t.countKey ? counts.value?.[t.countKey] : undefined}
    {@const active = isPathActive(t.href, current)}
    <a
      href={t.href}
      aria-current={active ? 'page' : undefined}
      class={cn(
        '-mb-px flex flex-col gap-0.5 border-b-2 px-4 pt-1 pb-2',
        active
          ? 'border-blue-500 text-white'
          : 'border-transparent text-dark-1 hover:text-white'
      )}
    >
      <span class="flex items-center gap-2 text-base font-medium">
        {t.label}
        <!-- Absent until loaded: a placeholder 0 reads as "nothing to review". -->
        {#if count !== undefined}
          <span
            class={cn(
              'rounded-full px-2 text-xs font-semibold tabular-nums',
              active ? 'bg-blue-500 text-white' : 'bg-dark-5 text-dark-1'
            )}
          >
            {num(count)}
          </span>
        {/if}
      </span>
      {#if t.hint}<span class="text-xs text-dark-2">{t.hint}</span>{/if}
    </a>
  {/each}
</nav>
