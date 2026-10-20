<script lang="ts">
  import { IconChevronDown } from '@tabler/icons-svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import * as DropdownMenu from '@civitai/ui/components/ui/dropdown-menu/index.js';
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
    /** Every pending hold, whatever the list is narrowed to; shown beside Pending in the status menu, null when it could not be read. */
    pendingCount: number | null;
  } = $props();

  const SELECTION = 'hold';
  const ALL = 'all';

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
  const statusGroup = $derived({
    key: 'status',
    label: 'Status',
    values: CSAM_HOLD_STATUSES,
    labels: CSAM_HOLD_STATUS_LABELS,
    active: filters.status,
    defaultValue: DEFAULT_CSAM_HOLD_FILTERS.status,
    counts: pendingCount === null ? undefined : { pending: pendingCount },
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

<div class="flex flex-col gap-1.5">

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

  <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
    <TriageFilterChips groups={[]} sort={statusGroup} selectionParam={SELECTION} />
    <TriageFilterChips groups={[]} sort={sortGroup} selectionParam={SELECTION} />
  </div>
</div>
