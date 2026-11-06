<script lang="ts">
  import { cn } from '@civitai/ui/utils.js';
  import { num } from '$lib/format';
  import { isPathActive } from '$lib/nav-links';
  import { sidebarCounts } from '$lib/sidebar-counts.svelte';

  let {
    tabs,
    current,
    label,
    compact = false,
  }: {
    /** Only the tabs to show; the caller has already dropped the ones the moderator can't open. */
    tabs: { label: string; href: string; countKey?: string; hint?: string }[];
    /** The pathname the page is on. */
    current: string;
    /** Accessible name of the tab bar. */
    label: string;
    /** A segmented switch for the top of a queue column: equal segments, the count under the label so
     *  neither is cut, the hint on hover. */
    compact?: boolean;
  } = $props();

  const counts = sidebarCounts();
</script>

{#snippet badge(count: number, active: boolean)}
  <span
    class={cn(
      'rounded-lg px-[7px] py-px text-[11px] font-semibold tabular-nums',
      active ? 'bg-blue-500 text-white' : 'bg-dark-6 text-dark-0'
    )}
  >
    {num(count)}
  </span>
{/snippet}

{#if compact}
  <nav
    class="grid auto-cols-fr grid-flow-col gap-0.5 rounded-md border border-dark-4 bg-dark-8 p-0.5"
    aria-label={label}
  >
    {#each tabs as t (t.href)}
      {@const count = t.countKey ? counts.value?.[t.countKey] : undefined}
      {@const active = isPathActive(t.href, current)}
      <a
        href={t.href}
        title={t.hint}
        aria-current={active ? 'page' : undefined}
        class={cn(
          'flex min-w-0 flex-col items-center justify-center gap-0.5 rounded px-1.5 py-1 text-[13px] leading-tight',
          active ? 'bg-dark-5 font-semibold text-white' : 'font-medium text-dark-0 hover:text-white'
        )}
      >
        <span class="whitespace-nowrap">{t.label}</span>
        <!-- Absent until loaded: a placeholder 0 reads as "nothing to review". -->
        {#if count !== undefined}{@render badge(count, active)}{/if}
      </a>
    {/each}
  </nav>
{:else}
  <nav class="flex items-end gap-1 border-b border-dark-4 px-6 pt-3.5" aria-label={label}>
    {#each tabs as t (t.href)}
      {@const count = t.countKey ? counts.value?.[t.countKey] : undefined}
      {@const active = isPathActive(t.href, current)}
      <a
        href={t.href}
        aria-current={active ? 'page' : undefined}
        class={cn(
          '-mb-px flex flex-col gap-0.5 border-b-2 px-3 pt-1.5 pb-2.5',
          active
            ? 'border-blue-500 font-semibold text-white'
            : 'border-transparent font-medium text-dark-0 hover:text-white'
        )}
      >
        <span class="flex items-center gap-2 text-sm">
          {t.label}
          <!-- Absent until loaded: a placeholder 0 reads as "nothing to review". -->
          {#if count !== undefined}{@render badge(count, active)}{/if}
        </span>
        {#if t.hint}<span class="text-[11px] font-normal text-dark-2">{t.hint}</span>{/if}
      </a>
    {/each}
  </nav>
{/if}
