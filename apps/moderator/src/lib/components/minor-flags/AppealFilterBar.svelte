<script lang="ts">
  import { page } from '$app/state';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import {
    APPEAL_FLAGS,
    APPEAL_SORTS,
    APPEAL_SOURCES,
    DEFAULT_APPEAL_FILTERS,
    FLAG_LABELS,
    SORT_LABELS,
    SOURCE_LABELS,
    type AppealFacets,
    type AppealFilters,
  } from '$lib/minor-flags/appeal-filters';
  import { num } from '$lib/format';
  import { urlWith } from '$lib/url';

  let { filters, facets }: { filters: AppealFilters; facets: AppealFacets | null } = $props();

  // Changing a filter changes the result set, so the page offset is dropped with it.
  const hrefFor = (key: keyof AppealFilters, value: string) =>
    urlWith(page.url, {
      [key]: value === DEFAULT_APPEAL_FILTERS[key] ? null : value,
      page: null,
    });
</script>

<div class="mb-4 grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2 text-xs">
  <span class="text-dark-2">Flag source</span>
  <div class="flex flex-wrap gap-1">
    {#each APPEAL_SOURCES as value (value)}
      <Button
        href={hrefFor('source', value)}
        size="xs"
        variant={filters.source === value ? 'default' : 'outline'}
        aria-current={filters.source === value ? 'true' : undefined}
      >
        {SOURCE_LABELS[value]}{facets ? ` · ${num(facets.source[value])}` : ''}
      </Button>
    {/each}
  </div>

  <span class="text-dark-2">Flag</span>
  <div class="flex flex-wrap gap-1">
    {#each APPEAL_FLAGS as value (value)}
      <Button
        href={hrefFor('flag', value)}
        size="xs"
        variant={filters.flag === value ? 'default' : 'outline'}
        aria-current={filters.flag === value ? 'true' : undefined}
      >
        {FLAG_LABELS[value]}{facets ? ` · ${num(facets.flag[value])}` : ''}
      </Button>
    {/each}
  </div>

  <span class="text-dark-2">Sort</span>
  <div class="flex flex-wrap gap-1">
    {#each APPEAL_SORTS as value (value)}
      <Button
        href={hrefFor('sort', value)}
        size="xs"
        variant={filters.sort === value ? 'default' : 'outline'}
        aria-current={filters.sort === value ? 'true' : undefined}
      >
        {SORT_LABELS[value]}
      </Button>
    {/each}
  </div>
</div>
