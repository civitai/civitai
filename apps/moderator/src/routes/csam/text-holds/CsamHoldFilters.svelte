<script lang="ts">
  import { IconChevronDown, IconEye, IconEyeOff } from '@tabler/icons-svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import * as DropdownMenu from '@civitai/ui/components/ui/dropdown-menu/index.js';
  import { Kbd } from '@civitai/ui/components/ui/kbd/index.js';
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
  import { LINK_BUTTON } from '$lib/format';
  import { imageReveal } from '$lib/csam-holds/image-reveal.svelte';
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
    typeCounts: Record<string, number> | null;
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
              <Button
                {...props}
                variant="ghost"
                size="sm"
                class="h-auto gap-1 px-1 py-[3px] text-xs font-normal text-dark-2 hover:bg-transparent hover:text-white"
              >
                {split.empty.length} empty <IconChevronDown class="size-3" aria-hidden="true" />
              </Button>
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
    <Button
      variant="outline"
      size="sm"
      class="ml-auto {LINK_BUTTON}"
      onclick={imageReveal.toggle}
    >
      {#if imageReveal.on}
        <IconEyeOff aria-hidden="true" /> Hide images
      {:else}
        <IconEye aria-hidden="true" /> Reveal images
      {/if}
      <Kbd class="h-4 min-w-0 px-1 text-[10px]">V</Kbd>
    </Button>
  </div>
</div>
