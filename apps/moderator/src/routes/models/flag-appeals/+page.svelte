<script lang="ts">
  import { page } from '$app/state';
  import { cn } from '@civitai/ui/utils.js';
  import QueueFilterBar, {
    type FilterGroup,
  } from '$lib/components/minor-flags/QueueFilterBar.svelte';
  import { num } from '$lib/format';
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
  import {
    DEFAULT_REDETECTED_FILTERS,
    REDETECTED_FLAGS,
    REDETECTED_FLAG_LABELS,
    REDETECTED_SORTS,
    REDETECTED_SORT_LABELS,
    redetectedFilterParams,
  } from '$lib/minor-flags/redetected-filters';
  import { urlWith } from '$lib/url';
  import AppealTriage from './AppealTriage.svelte';
  import RedetectedTriage from './RedetectedTriage.svelte';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  const views = [
    { value: 'appeals', label: 'Appeals' },
    { value: 'redetected', label: 'Re-detected' },
  ] as const;
  // Each view pages, filters and selects on its own, so switching drops all of it.
  const viewHref = (value: string) =>
    urlWith(page.url, {
      view: value === 'appeals' ? null : value,
      page: null,
      appeal: null,
      item: null,
      source: null,
      flag: null,
      sort: null,
    });

  const filterBar = $derived.by(() => {
    if (data.view === 'redetected') {
      const f = data.redetectedFilters;
      return {
        selectionParam: 'item',
        searchLabel: 'Search re-detections',
        searchParams: { view: 'redetected', ...redetectedFilterParams(f) },
        groups: [
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
        ] satisfies FilterGroup[],
      };
    }
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
    <nav
      aria-label="Queue"
      class="inline-flex gap-0.5 rounded-lg border border-dark-4 bg-dark-7 p-0.5"
    >
      {#each views as view (view.value)}
        <a
          href={viewHref(view.value)}
          aria-current={data.view === view.value ? 'true' : undefined}
          class={cn(
            'rounded-md px-3 py-1.5 text-sm transition-colors',
            data.view === view.value
              ? 'bg-blue-600 font-medium text-white'
              : 'text-dark-0 hover:bg-dark-5 hover:text-white'
          )}
        >
          {view.label}
          {#if view.value === 'redetected' && data.redetectedCount}
            <span
              class={cn(
                'ml-1.5 rounded-full px-1.5 text-xs tabular-nums',
                data.view === view.value ? 'bg-blue-500 text-white' : 'bg-dark-4 text-dark-0'
              )}
            >
              {num(data.redetectedCount)}
            </span>
          {/if}
        </a>
      {/each}
    </nav>
  </div>
  <QueueFilterBar
    groups={filterBar.groups}
    q={data.q}
    searchLabel={filterBar.searchLabel}
    searchParams={filterBar.searchParams}
    selectionParam={filterBar.selectionParam}
  />
  {#if data.view === 'redetected'}
    <RedetectedTriage {data} {form} />
  {:else}
    <AppealTriage {data} {form} />
  {/if}
</div>
