<script lang="ts">
  import { page } from '$app/state';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import { cn } from '@civitai/ui/utils.js';
  import {
    APPEAL_FLAGS,
    APPEAL_SORTS,
    APPEAL_SOURCES,
    DEFAULT_APPEAL_FILTERS,
    FLAG_LABELS,
    SORT_LABELS,
    SOURCE_LABELS,
    appealFilterParams,
    type AppealFacets,
    type AppealFilters,
  } from '$lib/minor-flags/appeal-filters';
  import { num } from '$lib/format';
  import { urlWith } from '$lib/url';

  let {
    filters,
    facets,
    q,
  }: { filters: AppealFilters; facets: AppealFacets | null; q: string } = $props();

  // Page and selection index into the old result set.
  const hrefFor = (key: keyof AppealFilters, value: string) =>
    urlWith(page.url, {
      [key]: value === DEFAULT_APPEAL_FILTERS[key] ? null : value,
      page: null,
      appeal: null,
    });

  const clearSearchHref = $derived(urlWith(page.url, { q: null, page: null, appeal: null }));

  const groups = $derived([
    {
      key: 'source',
      label: 'Source',
      values: APPEAL_SOURCES,
      labels: SOURCE_LABELS,
      counts: facets?.source,
    },
    {
      key: 'flag',
      label: 'Flag',
      values: APPEAL_FLAGS,
      labels: FLAG_LABELS,
      counts: facets?.flag,
    },
    { key: 'sort', label: 'Sort', values: APPEAL_SORTS, labels: SORT_LABELS, counts: undefined },
  ] as const);
</script>

<div class="flex flex-wrap items-end gap-x-6 gap-y-3">
  {#each groups as group (group.key)}
    <div class="flex flex-col gap-1">
      <span class="text-sm font-medium text-dark-2">{group.label}</span>
      <nav
        aria-label={group.label}
        class="inline-flex flex-wrap gap-0.5 rounded-lg border border-dark-4 bg-dark-7 p-0.5"
      >
        {#each group.values as value (value)}
          {@const active = filters[group.key] === value}
          {@const count = (group.counts as Record<string, number> | undefined)?.[value]}
          <a
            href={hrefFor(group.key, value)}
            data-sveltekit-noscroll
            data-sveltekit-keepfocus
            aria-current={active ? 'true' : undefined}
            class={cn(
              'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors',
              active
                ? 'bg-blue-600 font-medium text-white'
                : 'text-dark-0 hover:bg-dark-5 hover:text-white'
            )}
          >
            {group.labels[value as keyof typeof group.labels]}
            {#if count !== undefined}
              <span class={cn('text-xs tabular-nums', active ? 'text-blue-100' : 'text-dark-2')}>
                {num(count)}
              </span>
            {/if}
          </a>
        {/each}
      </nav>
    </div>
  {/each}

  <!-- Keyed on q: the Input's value is bindable, so a one-way prop would latch on what was typed. -->
  {#key q}
    <form method="GET" class="ml-auto flex w-full max-w-[24rem] items-center gap-2">
      {#each Object.entries(appealFilterParams(filters)) as [name, value] (name)}
        <input type="hidden" {name} {value} />
      {/each}
      <Input
        name="q"
        value={q}
        placeholder="Model ID, user ID or username"
        aria-label="Search appeals"
        class="h-9 flex-1 text-sm"
      />
      <Button type="submit" size="lg">Search</Button>
      {#if q}
        <Button href={clearSearchHref} variant="outline" size="lg">Clear</Button>
      {/if}
    </form>
  {/key}
</div>
