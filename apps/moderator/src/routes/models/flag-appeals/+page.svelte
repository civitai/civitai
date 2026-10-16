<script lang="ts">
  import QueueFilterBar, {
    type FilterGroup,
  } from '$lib/components/minor-flags/QueueFilterBar.svelte';
  import {
    APPEAL_FLAGS,
    APPEAL_SORTS,
    APPEAL_SOURCES,
    DEFAULT_APPEAL_FILTERS,
    FLAG_LABELS,
    SORT_LABELS,
    SOURCE_LABELS,
    appealFilterParams,
  } from '$lib/minor-flags/appeal-filters';
  import AppealTriage from './AppealTriage.svelte';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  const filterBar = $derived.by(() => {
    const f = data.appealFilters;
    return {
      selectionParam: 'appeal',
      searchLabel: 'Search appeals',
      searchParams: appealFilterParams(f),
      groups: [
        {
          key: 'source',
          label: 'Source',
          values: APPEAL_SOURCES,
          labels: SOURCE_LABELS,
          active: f.source,
          defaultValue: DEFAULT_APPEAL_FILTERS.source,
          counts: data.facets?.source,
        },
        {
          key: 'flag',
          label: 'Flag',
          values: APPEAL_FLAGS,
          labels: FLAG_LABELS,
          active: f.flag,
          defaultValue: DEFAULT_APPEAL_FILTERS.flag,
          counts: data.facets?.flag,
        },
        {
          key: 'sort',
          label: 'Sort',
          values: APPEAL_SORTS,
          labels: SORT_LABELS,
          active: f.sort,
          defaultValue: DEFAULT_APPEAL_FILTERS.sort,
        },
      ] satisfies FilterGroup[],
    };
  });
</script>

<div class="flex flex-col gap-3 px-6 pb-4 lg:h-[calc(100svh-3rem)]">
  <div class="flex flex-wrap items-center gap-4">
    <h1 class="m-0 text-xl font-semibold text-white">Model Flag Appeals</h1>
  </div>
  <QueueFilterBar
    groups={filterBar.groups}
    q={data.q}
    searchLabel={filterBar.searchLabel}
    searchParams={filterBar.searchParams}
    selectionParam={filterBar.selectionParam}
  />
  <AppealTriage {data} {form} />
</div>
