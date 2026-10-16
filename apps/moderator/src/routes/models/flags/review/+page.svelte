<script lang="ts">
  import QueueFilterBar, {
    type FilterGroup,
  } from '$lib/components/minor-flags/QueueFilterBar.svelte';
  import {
    DEFAULT_REDETECTED_FILTERS,
    REDETECTED_FLAGS,
    REDETECTED_FLAG_LABELS,
    REDETECTED_SORTS,
    REDETECTED_SORT_LABELS,
    redetectedFilterParams,
  } from '$lib/minor-flags/redetected-filters';
  import ModelFlagsTabs from '../ModelFlagsTabs.svelte';
  import HeldDetectionTriage from './HeldDetectionTriage.svelte';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  const groups = $derived.by(() => {
    const f = data.redetectedFilters;
    return [
      {
        key: 'flag',
        label: 'Flag',
        values: REDETECTED_FLAGS,
        labels: REDETECTED_FLAG_LABELS,
        active: f.flag,
        defaultValue: DEFAULT_REDETECTED_FILTERS.flag,
      },
      {
        key: 'sort',
        label: 'Sort',
        values: REDETECTED_SORTS,
        labels: REDETECTED_SORT_LABELS,
        active: f.sort,
        defaultValue: DEFAULT_REDETECTED_FILTERS.sort,
      },
    ] satisfies FilterGroup[];
  });
</script>

<div class="flex flex-col gap-3 px-6 pb-4 lg:h-[calc(100svh-3rem)]">
  <h1 class="m-0 text-xl font-semibold text-white">Model Flags</h1>
  <ModelFlagsTabs />
  <QueueFilterBar
    {groups}
    q={data.q}
    searchLabel="Search detections"
    searchParams={redetectedFilterParams(data.redetectedFilters)}
    selectionParam="item"
  />
  <HeldDetectionTriage {data} {form} />
</div>
