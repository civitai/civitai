<script lang="ts">
  import QueueFilterBar, {
    type FilterGroup,
  } from '$lib/components/minor-flags/QueueFilterBar.svelte';
  import {
    DEFAULT_FLAGGED_FILTERS,
    FLAGGED_FLAGS,
    FLAGGED_FLAG_LABELS,
    FLAGGED_SORTS,
    FLAGGED_SORT_LABELS,
    FLAGGED_SOURCES,
    FLAGGED_SOURCE_LABELS,
    flaggedFilterParams,
  } from '$lib/minor-flags/flagged-filters';
  import ModelFlagsTabs from '../ModelFlagsTabs.svelte';
  import FlaggedTriage from './FlaggedTriage.svelte';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  const groups = $derived.by(() => {
    const f = data.flaggedFilters;
    return [
      {
        key: 'source',
        label: 'Source',
        values: FLAGGED_SOURCES,
        labels: FLAGGED_SOURCE_LABELS,
        active: f.source,
        defaultValue: DEFAULT_FLAGGED_FILTERS.source,
      },
      {
        key: 'flag',
        label: 'Flag',
        values: FLAGGED_FLAGS,
        labels: FLAGGED_FLAG_LABELS,
        active: f.flag,
        defaultValue: DEFAULT_FLAGGED_FILTERS.flag,
      },
      {
        key: 'sort',
        label: 'Sort',
        values: FLAGGED_SORTS,
        labels: FLAGGED_SORT_LABELS,
        active: f.sort,
        defaultValue: DEFAULT_FLAGGED_FILTERS.sort,
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
    searchLabel="Search flags"
    searchParams={flaggedFilterParams(data.flaggedFilters)}
    selectionParam="item"
  />
  <FlaggedTriage {data} {form} />
</div>
