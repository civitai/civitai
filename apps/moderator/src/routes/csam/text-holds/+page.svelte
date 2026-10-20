<script lang="ts">
  import QueueFilterBar, {
    type FilterGroup,
  } from '$lib/components/minor-flags/QueueFilterBar.svelte';
  import {
    CSAM_HOLD_SORTS,
    CSAM_HOLD_SORT_LABELS,
    CSAM_HOLD_STATUSES,
    CSAM_HOLD_STATUS_LABELS,
    DEFAULT_CSAM_HOLD_FILTERS,
    csamHoldFilterParams,
  } from '$lib/csam-holds/hold-filters';
  import CsamHoldTriage from './CsamHoldTriage.svelte';
  import { CSAM_HOLD_ENTITY_TYPES, entityLabel } from './hold-entity';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  const ALL = 'all';

  const groups = $derived.by(() => {
    const f = data.holdFilters;
    return [
      {
        key: 'status',
        label: 'Status',
        values: CSAM_HOLD_STATUSES,
        labels: CSAM_HOLD_STATUS_LABELS,
        active: f.status,
        defaultValue: DEFAULT_CSAM_HOLD_FILTERS.status,
      },
      {
        key: 'entityType',
        label: 'Type',
        values: [ALL, ...CSAM_HOLD_ENTITY_TYPES],
        labels: {
          [ALL]: 'All',
          ...Object.fromEntries(CSAM_HOLD_ENTITY_TYPES.map((t) => [t, entityLabel(t)])),
        },
        active: data.entityType ?? ALL,
        defaultValue: ALL,
        counts: data.typeCounts ?? undefined,
      },
      {
        key: 'sort',
        label: 'Sort',
        values: CSAM_HOLD_SORTS,
        labels: CSAM_HOLD_SORT_LABELS,
        active: f.sort,
        defaultValue: DEFAULT_CSAM_HOLD_FILTERS.sort,
      },
    ] satisfies FilterGroup[];
  });
</script>

<div class="flex flex-col gap-3 px-6 pb-4 lg:h-[calc(100svh-3rem)]">
  <h1 class="m-0 text-xl font-semibold text-white">CSAM text holds</h1>
  <QueueFilterBar
    {groups}
    q={data.q}
    searchLabel="Search holds"
    placeholder="Username, user ID or content ID"
    searchParams={csamHoldFilterParams(data.holdFilters, data.entityType)}
    selectionParam="hold"
  />
  <CsamHoldTriage
    {data}
    {form}
    canDecide={data.grants['csam.report.file'] === true}
    canStrike={data.grants['user.strike'] === true}
    canBan={data.grants['user.ban'] === true}
  />
</div>
