<script module lang="ts">
  export type ChipGroup = {
    key: string;
    label: string;
    values: readonly string[];
    labels: Record<string, string>;
    active: string;
    defaultValue: string;
    /** Drops the default chip and lets the active chip switch itself off, so several groups can share
     *  one row under a single "All". */
    toggle?: boolean;
    /** A number after a chip's label (models it would list); a value with none shows no number. */
    counts?: Partial<Record<string, number>>;
    /** Params cleared when this group changes, because they only made sense for the old value. */
    resets?: readonly string[];
    /** Chips only: counts of 1,000 or more read as "2.4k" and the padding is tighter, so a row of chips
     *  keeps to one line in a narrow list. */
    compact?: boolean;
    /** The sort select only: a bordered pill, "Label Value", with the active count as a blue badge. */
    pill?: boolean;
  };
</script>

<script lang="ts">
  import type { Snippet } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import * as Select from '@civitai/ui/components/ui/select/index.js';
  import { cn } from '@civitai/ui/utils.js';
  import { chipHref, rowChips } from '$lib/triage/filters';

  let {
    groups = [],
    status,
    sort,
    selectionParam,
    trailing,
  }: {
    groups?: ChipGroup[];
    /** A status select, rendered as the sort select is, ahead of it. */
    status?: ChipGroup;
    sort?: ChipGroup;
    /** The URL param holding the open item; it indexes the old result set, so a filter drops it. */
    selectionParam: string;
    trailing?: Snippet;
  } = $props();

  const hrefFor = (group: ChipGroup, value: string) =>
    chipHref(page.url, group, value, selectionParam);
  const go = (href: string) => goto(href, { noScroll: true, keepFocus: true });
  const chips = $derived(rowChips(groups));
  const countText = (group: ChipGroup, value: string) => {
    const n = group.counts?.[value];
    if (n == null) return '';
    if (!group.compact || n < 1000) return String(n);
    return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  };
  const PILL_CONTROL =
    'h-[26px] gap-1.5 rounded-md border-dark-4 bg-dark-7 px-2.5 text-white shadow-none outline-none hover:bg-dark-6 focus-visible:ring-2 focus-visible:ring-blue-500/50 dark:bg-dark-7 dark:hover:bg-dark-6 [&>svg]:size-3 [&>svg]:text-dark-2';
  const TEXT_CONTROL =
    'inline-flex items-center gap-1 rounded px-1 py-[3px] text-xs text-dark-2 outline-none hover:text-white focus-visible:ring-2 focus-visible:ring-blue-500/50';
</script>

{#snippet count(group: ChipGroup, value: string)}
  {#if group.counts?.[value] != null}
    <span class="tabular-nums text-dark-2">{countText(group, value)}</span>
  {/if}
{/snippet}

{#snippet select(group: ChipGroup)}
  <!-- A function binding: the URL owns the group, so a one-way value prop could latch. -->
  <Select.Root
    type="single"
    bind:value={
      () => group.active,
      (value) => {
        if (value && value !== group.active) go(hrefFor(group, value));
      }
    }
  >
    <Select.Trigger
      aria-label={group.label}
      class={group.pill ? PILL_CONTROL : `${TEXT_CONTROL} h-auto border-0 bg-transparent shadow-none dark:bg-transparent dark:hover:bg-transparent [&>svg]:size-3`}
    >
      {#if group.pill}
        <span class="text-xs text-dark-2">{group.label}</span>
        <span class="text-[13px] font-medium text-white">{group.labels[group.active]}</span>
        {#if group.counts?.[group.active] != null}
          <span
            class="rounded-lg bg-blue-500 px-[7px] py-px text-[11px] font-semibold text-white tabular-nums"
            >{countText(group, group.active)}</span
          >
        {/if}
      {:else}
        {group.labels[group.active]}
        {@render count(group, group.active)}
      {/if}
    </Select.Trigger>
    <Select.Content>
      {#each group.values as value (value)}
        <Select.Item {value}>{group.labels[value]} {@render count(group, value)}</Select.Item>
      {/each}
    </Select.Content>
  </Select.Root>
{/snippet}

<div class={cn('flex flex-wrap items-center', groups.some((g) => g.compact) ? 'gap-1' : 'gap-1.5')}>
  {#each chips as { group, value } (`${group.key}:${value}`)}
    {@const active = group.active === value}
    <a
      href={hrefFor(group, value)}
      data-sveltekit-noscroll
      data-sveltekit-keepfocus
      aria-current={active ? 'true' : undefined}
      class={cn(
        'inline-flex items-center rounded-full border py-[3px] text-xs leading-[15px] transition-colors',
        group.compact ? 'px-1.5 whitespace-nowrap' : 'px-[9px]',
        active
          ? 'border-dark-5 bg-dark-5 text-white'
          : 'border-dark-4 text-dark-1 hover:bg-dark-5 hover:text-white'
      )}
    >
      {group.labels[value]}
      {#if group.counts?.[value] != null}
        <span
          class="tabular-nums {group.compact ? 'ml-[3px]' : 'ml-1'} {active ? 'text-dark-0' : 'text-dark-2'}"
          >{countText(group, value)}</span
        >
      {/if}
    </a>
  {/each}
  {@render trailing?.()}
  {#if status}{@render select(status)}{/if}
  {#if sort}{@render select(sort)}{/if}
</div>
