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
    tabs: { value: string; label: string; /** Shown on hover. */ hint?: string }[];
    current: string;
    /** The URL param holding the tab. */
    param: string;
    defaultValue: string;
    label: string;
    /** Dropped on a tab switch: the open item and page index belong to the old result set. */
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

<!-- Top of the list column, as `TriageTabs` compact: equal segments, the count under the label. -->
<nav
  class="grid auto-cols-fr grid-flow-col gap-0.5 rounded-md border border-dark-4 bg-dark-8 p-0.5"
  aria-label={label}
>
  {#each tabs as tab (tab.value)}
    {@const active = tab.value === current}
    {@const count = counts?.[tab.value]}
    <a
      href={hrefFor(tab.value)}
      title={tab.hint}
      data-sveltekit-noscroll
      data-sveltekit-keepfocus
      aria-current={active ? 'page' : undefined}
      class={cn(
        'flex min-w-0 flex-col items-center justify-center gap-0.5 rounded px-1.5 py-1 text-[13px] leading-tight',
        active ? 'bg-dark-5 font-semibold text-white' : 'font-medium text-dark-0 hover:text-white'
      )}
    >
      <span class="whitespace-nowrap">{tab.label}</span>
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
    </a>
  {/each}
</nav>
