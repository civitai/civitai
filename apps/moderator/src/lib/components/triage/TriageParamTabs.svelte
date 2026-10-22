<script lang="ts">
  import { page } from '$app/state';
  import { cn } from '@civitai/ui/utils.js';
  import { num } from '$lib/format';
  import { urlWith } from '$lib/url';

  let {
    tabs,
    current,
    param,
    defaultValue,
    label,
    selectionParam,
    counts,
  }: {
    tabs: { value: string; label: string; hint?: string }[];
    current: string;
    /** The URL param holding the tab; the default tab leaves it off. */
    param: string;
    defaultValue: string;
    label: string;
    /** The open item and the page index the result set being replaced. */
    selectionParam: string;
    /** Absent while the counts are unavailable: a placeholder 0 reads as "nothing to review". */
    counts?: Partial<Record<string, number>> | undefined;
  } = $props();

  const hrefFor = (value: string) =>
    urlWith(page.url, {
      [param]: value === defaultValue ? null : value,
      page: null,
      [selectionParam]: null,
    });
</script>

<nav class="flex items-end gap-1 border-b border-dark-4 px-6 pt-3.5" aria-label={label}>
  {#each tabs as tab (tab.value)}
    {@const active = tab.value === current}
    {@const count = counts?.[tab.value]}
    <a
      href={hrefFor(tab.value)}
      data-sveltekit-noscroll
      data-sveltekit-keepfocus
      aria-current={active ? 'page' : undefined}
      class={cn(
        '-mb-px flex flex-col gap-0.5 border-b-2 px-3 pt-1.5 pb-2.5',
        active
          ? 'border-blue-500 font-semibold text-white'
          : 'border-transparent font-medium text-dark-0 hover:text-white'
      )}
    >
      <span class="flex items-center gap-2 text-sm">
        {tab.label}
        {#if count !== undefined}
          <span
            class={cn(
              'rounded-lg px-[7px] py-px text-[11px] font-semibold tabular-nums',
              active ? 'bg-blue-500 text-white' : 'bg-dark-6 text-dark-0'
            )}
          >
            {num(count)}
          </span>
        {/if}
      </span>
      {#if tab.hint}<span class="text-[11px] font-normal text-dark-2">{tab.hint}</span>{/if}
    </a>
  {/each}
</nav>
