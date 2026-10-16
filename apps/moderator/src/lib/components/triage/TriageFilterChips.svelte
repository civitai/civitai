<script module lang="ts">
  export type ChipGroup = {
    key: string;
    label: string;
    values: readonly string[];
    labels: Record<string, string>;
    active: string;
    defaultValue: string;
    counts?: Record<string, number>;
    /** Drops the default chip and lets the active chip switch itself off, so several groups can share
     *  one row under a single "All". */
    toggle?: boolean;
  };
</script>

<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { NativeSelect } from '@civitai/ui/components/ui/native-select/index.js';
  import { cn } from '@civitai/ui/utils.js';
  import { num } from '$lib/format';
  import { urlWith } from '$lib/url';

  let {
    groups,
    sort,
    selectionParam,
  }: {
    groups: ChipGroup[];
    sort?: ChipGroup;
    /** The URL param holding the open item; it indexes the old result set, so a filter drops it. */
    selectionParam: string;
  } = $props();

  const hrefFor = (group: ChipGroup, value: string) =>
    urlWith(page.url, {
      [group.key]: value === group.defaultValue ? null : value,
      page: null,
      [selectionParam]: null,
    });
</script>

<div class="flex flex-wrap items-center gap-1.5">
  {#each groups as group (group.key)}
    {#each group.values as value (value)}
      {#if !group.toggle || value !== group.defaultValue}
        {@const active = group.active === value}
        {@const count = group.counts?.[value]}
        <a
          href={hrefFor(group, active && group.toggle ? group.defaultValue : value)}
          data-sveltekit-noscroll
          data-sveltekit-keepfocus
          aria-current={active ? 'true' : undefined}
          class={cn(
            'inline-flex items-center gap-1 rounded-full border px-3 py-0.5 text-xs transition-colors',
            active
              ? 'border-dark-5 bg-dark-5 text-white'
              : 'border-dark-4 text-dark-1 hover:bg-dark-5 hover:text-white'
          )}
        >
          {group.labels[value]}
          {#if count !== undefined}
            <span class="tabular-nums text-dark-2">{num(count)}</span>
          {/if}
        </a>
      {/if}
    {/each}
  {/each}
  {#if sort}
    <NativeSelect
      aria-label={sort.label}
      value={sort.active}
      class="h-7 border-0 bg-transparent py-0 ps-2 pe-7 text-xs text-dark-1 shadow-none"
      onchange={(e) =>
        goto(hrefFor(sort, e.currentTarget.value), { noScroll: true, keepFocus: true })}
    >
      {#each sort.values as value (value)}
        <option {value}>{sort.labels[value]}</option>
      {/each}
    </NativeSelect>
  {/if}
</div>
