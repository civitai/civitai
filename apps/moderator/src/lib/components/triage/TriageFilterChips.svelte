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
    /** Values kept off the row behind a "More" menu; one in force still shows on the row. */
    more?: readonly string[];
    /** A number after a chip's label (models it would list); a value with none shows no number. */
    counts?: Partial<Record<string, number>>;
  };
</script>

<script lang="ts">
  import { IconChevronDown } from '@tabler/icons-svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import * as DropdownMenu from '@civitai/ui/components/ui/dropdown-menu/index.js';
  import * as Select from '@civitai/ui/components/ui/select/index.js';
  import { cn } from '@civitai/ui/utils.js';
  import { chipHref, splitChips } from '$lib/triage/filters';

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
    chipHref(page.url, group, value, selectionParam);
  const go = (href: string) => goto(href, { noScroll: true, keepFocus: true });
  const chips = $derived(splitChips(groups));
  const TEXT_CONTROL =
    'inline-flex items-center gap-1 rounded px-1 py-[3px] text-xs text-dark-2 outline-none hover:text-white focus-visible:ring-2 focus-visible:ring-blue-500/50';
</script>

<div class="flex flex-wrap items-center gap-1.5">
  {#each chips.row as { group, value } (`${group.key}:${value}`)}
    {@const active = group.active === value}
    <a
      href={hrefFor(group, value)}
      data-sveltekit-noscroll
      data-sveltekit-keepfocus
      aria-current={active ? 'true' : undefined}
      class={cn(
        'inline-flex items-center rounded-full border px-[9px] py-[3px] text-xs leading-[15px] transition-colors',
        active
          ? 'border-dark-5 bg-dark-5 text-white'
          : 'border-dark-4 text-dark-1 hover:bg-dark-5 hover:text-white'
      )}
    >
      {group.labels[value]}
      {#if group.counts?.[value] != null}
        <span class="ml-1 tabular-nums {active ? 'text-dark-0' : 'text-dark-2'}"
          >{group.counts[value]}</span
        >
      {/if}
    </a>
  {/each}
  {#if chips.more.length}
    <DropdownMenu.Root>
      <DropdownMenu.Trigger class={TEXT_CONTROL} aria-label="More filters">
        More <IconChevronDown class="size-3" aria-hidden="true" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Content align="start">
        {#each chips.more as { group, value } (`${group.key}:${value}`)}
          <DropdownMenu.Item onSelect={() => go(hrefFor(group, value))}>
            {group.labels[value]}
          </DropdownMenu.Item>
        {/each}
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  {/if}
  {#if sort}
    <!-- A function binding: the URL owns the sort, so a one-way value prop could latch. -->
    <Select.Root
      type="single"
      bind:value={
        () => sort.active,
        (value) => {
          if (value && value !== sort.active) go(hrefFor(sort, value));
        }
      }
    >
      <Select.Trigger
        aria-label={sort.label}
        class="{TEXT_CONTROL} h-auto border-0 bg-transparent shadow-none dark:bg-transparent dark:hover:bg-transparent [&>svg]:size-3"
      >
        {sort.labels[sort.active]}
      </Select.Trigger>
      <Select.Content>
        {#each sort.values as value (value)}
          <Select.Item {value}>{sort.labels[value]}</Select.Item>
        {/each}
      </Select.Content>
    </Select.Root>
  {/if}
</div>
