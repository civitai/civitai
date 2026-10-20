<script lang="ts">
  import { IconChevronDown } from '@tabler/icons-svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import * as DropdownMenu from '@civitai/ui/components/ui/dropdown-menu/index.js';
  import { cn } from '@civitai/ui/utils.js';
  import TriageFilterChips, {
    type ChipGroup,
  } from '$lib/components/triage/TriageFilterChips.svelte';
  import {
    CSAM_HOLD_SORTS,
    CSAM_HOLD_SORT_LABELS,
    CSAM_HOLD_STATUSES,
    CSAM_HOLD_STATUS_LABELS,
    DEFAULT_CSAM_HOLD_FILTERS,
    type CsamHoldFilters,
  } from '$lib/csam-holds/hold-filters';
  import { chipHref } from '$lib/triage/filters';
  import { CSAM_HOLD_ENTITY_TYPES, entityLabel, splitEmptyTypes } from './hold-entity';

  let {
    filters,
    entityType,
    typeCounts,
    pendingCount,
  }: {
    filters: CsamHoldFilters;
    entityType: string | null;
    /** Holds per type for the shown status and search, plus `all`; null when they could not be read. */
    typeCounts: Record<string, number> | null;
    /** Every pending hold, whatever the list is narrowed to; null when it could not be read. */
    pendingCount: number | null;
  } = $props();

  const SELECTION = 'hold';
  const ALL = 'all';

  const statusHref = (value: string) =>
    chipHref(
      page.url,
      { key: 'status', defaultValue: DEFAULT_CSAM_HOLD_FILTERS.status, active: filters.status },
      value,
      SELECTION
    );

  const split = $derived(splitEmptyTypes(CSAM_HOLD_ENTITY_TYPES, typeCounts, entityType));
  const typeGroup = $derived({
    key: 'entityType',
    label: 'Type',
    values: [ALL, ...split.shown],
    labels: {
      [ALL]: 'All',
      ...Object.fromEntries(CSAM_HOLD_ENTITY_TYPES.map((t) => [t, entityLabel(t)])),
    },
    active: entityType ?? ALL,
    defaultValue: ALL,
    counts: typeCounts ?? undefined,
  } satisfies ChipGroup);
  const sortGroup = $derived({
    key: 'sort',
    label: 'Sort',
    values: CSAM_HOLD_SORTS,
    labels: CSAM_HOLD_SORT_LABELS,
    active: filters.sort,
    defaultValue: DEFAULT_CSAM_HOLD_FILTERS.sort,
  } satisfies ChipGroup);

  const emptyHref = (type: string) => chipHref(page.url, typeGroup, type, SELECTION);
</script>

<div class="flex flex-col gap-2.5">
  <nav
    aria-label="Hold status"
    class="inline-flex self-start rounded-md border border-dark-4 bg-dark-8 p-0.5"
  >
    {#each CSAM_HOLD_STATUSES as value (value)}
      {@const active = filters.status === value}
      <a
        href={statusHref(value)}
        data-sveltekit-noscroll
        data-sveltekit-keepfocus
        aria-current={active ? 'true' : undefined}
        class={cn(
          'inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-xs transition-colors',
          active ? 'bg-dark-5 text-white' : 'text-dark-1 hover:text-white'
        )}
      >
        {CSAM_HOLD_STATUS_LABELS[value]}
        {#if value === 'pending' && pendingCount}
          <span
            class="rounded-full bg-red-600 px-1.5 text-[11px] leading-4 font-semibold text-white tabular-nums"
            >{pendingCount}</span
          >
        {/if}
      </a>
    {/each}
  </nav>

  <TriageFilterChips groups={[typeGroup]} selectionParam={SELECTION}>
    {#snippet trailing()}
      {#if split.empty.length}
        <DropdownMenu.Root>
          <DropdownMenu.Trigger>
            {#snippet child({ props })}
              <button
                {...props}
                type="button"
                class="inline-flex items-center gap-1 rounded px-1 py-[3px] text-xs text-dark-2 outline-none hover:text-white focus-visible:ring-2 focus-visible:ring-blue-500/50"
              >
                {split.empty.length} empty <IconChevronDown class="size-3" aria-hidden="true" />
              </button>
            {/snippet}
          </DropdownMenu.Trigger>
          <DropdownMenu.Content align="start">
            {#each split.empty as type (type)}
              <DropdownMenu.Item
                onSelect={() => goto(emptyHref(type), { noScroll: true, keepFocus: true })}
              >
                {entityLabel(type)}
                <span class="ml-auto text-dark-2 tabular-nums">0</span>
              </DropdownMenu.Item>
            {/each}
          </DropdownMenu.Content>
        </DropdownMenu.Root>
      {/if}
    {/snippet}
  </TriageFilterChips>

  <TriageFilterChips groups={[]} sort={sortGroup} selectionParam={SELECTION} />
</div>
