<script module lang="ts">
  export type FilterGroup = {
    key: string;
    label: string;
    values: readonly string[];
    labels: Record<string, string>;
    active: string;
    defaultValue: string;
    counts?: Record<string, number>;
  };
</script>

<script lang="ts">
  import { page } from '$app/state';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import { cn } from '@civitai/ui/utils.js';
  import { num } from '$lib/format';
  import { urlWith } from '$lib/url';

  let {
    groups,
    q,
    searchLabel,
    searchParams,
    selectionParam,
  }: {
    groups: FilterGroup[];
    q: string;
    searchLabel: string;
    /** What a search keeps: the non-default filters and the view, since the form is a plain GET. */
    searchParams: Record<string, string>;
    /** The URL param holding the open item; it indexes the old result set, so a filter drops it. */
    selectionParam: string;
  } = $props();

  const hrefFor = (group: FilterGroup, value: string) =>
    urlWith(page.url, {
      [group.key]: value === group.defaultValue ? null : value,
      page: null,
      [selectionParam]: null,
    });

  const clearSearchHref = $derived(urlWith(page.url, { q: null, page: null, [selectionParam]: null }));
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
          {@const active = group.active === value}
          {@const count = group.counts?.[value]}
          <a
            href={hrefFor(group, value)}
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
            {group.labels[value]}
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
      {#each Object.entries(searchParams) as [name, value] (name)}
        <input type="hidden" {name} {value} />
      {/each}
      <Input
        name="q"
        value={q}
        placeholder="Model ID, user ID or username"
        aria-label={searchLabel}
        class="h-9 flex-1 text-sm"
      />
      <Button type="submit" size="lg">Search</Button>
      {#if q}
        <Button href={clearSearchHref} variant="outline" size="lg">Clear</Button>
      {/if}
    </form>
  {/key}
</div>
