<script lang="ts">
  import { page } from '$app/state';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import { cn } from '@civitai/ui/utils.js';
  import { num } from '$lib/format';
  import { RESTRICTION_TYPE_LABELS, type RestrictionType } from '$lib/restriction-types';
  import type { RestrictionFacets } from '$lib/server/user-restriction.service';
  import { urlWith } from '$lib/url';

  let {
    type,
    types,
    fallbackType,
    status,
    origin,
    facets,
    q,
  }: {
    type: RestrictionType;
    types: readonly RestrictionType[];
    fallbackType: RestrictionType;
    status: string;
    origin: string | null;
    facets: RestrictionFacets;
    q: string;
  } = $props();

  type Chip = { value: string; label: string; count?: number };
  const statuses = $derived<Chip[]>([
    { value: 'Pending', label: 'Pending', count: facets.status.Pending },
    { value: 'Upheld', label: 'Upheld', count: facets.status.Upheld },
    { value: 'Overturned', label: 'Overturned', count: facets.status.Overturned },
    { value: 'any', label: 'Any', count: facets.status.any },
  ]);
  const origins = $derived<Chip[]>([
    { value: '', label: 'All', count: facets.origin.all },
    { value: 'remix', label: 'Has a remix', count: facets.origin.remix },
    { value: 'typed', label: 'Typed', count: facets.origin.typed },
    { value: 'unchanged-remix', label: 'Unchanged remix', count: facets.origin['unchanged-remix'] },
  ]);
  const typeChips = $derived<Chip[]>(types.map((t) => ({ value: t, label: RESTRICTION_TYPE_LABELS[t] })));

  // Page and selection index into the result set being replaced.
  const hrefFor = (key: string, value: string, fallback: string | null) =>
    urlWith(page.url, {
      [key]: value === (fallback ?? '') ? null : value,
      page: null,
      selected: null,
    });

  const groups = $derived(
    [
      types.length > 1 && {
        key: 'type',
        label: 'Type',
        chips: typeChips,
        current: type,
        fallback: fallbackType,
      },
      { key: 'status', label: 'Status', chips: statuses, current: status, fallback: 'Pending' },
      { key: 'origin', label: 'Origin', chips: origins, current: origin ?? '', fallback: null },
    ].filter((g) => !!g)
  );

  const clearSearchHref = $derived(urlWith(page.url, { q: null, page: null, selected: null }));
</script>

<div class="flex flex-wrap items-end gap-x-6 gap-y-3">
  {#each groups as group (group.key)}
    <div class="flex flex-col gap-1">
      <span class="text-sm font-medium text-dark-2">{group.label}</span>
      <nav
        aria-label={group.label}
        class="inline-flex flex-wrap gap-0.5 rounded-lg border border-dark-4 bg-dark-7 p-0.5"
      >
        {#each group.chips as chip (chip.value)}
          {@const active = group.current === chip.value}
          <a
            href={hrefFor(group.key, chip.value, group.fallback)}
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
            {chip.label}
            {#if chip.count !== undefined}
              <span class={cn('text-xs tabular-nums', active ? 'text-blue-100' : 'text-dark-2')}>
                {num(chip.count)}
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
      {#each [['type', type === fallbackType ? '' : type], ['status', status === 'Pending' ? '' : status], ['origin', origin ?? '']] as [name, value] (name)}
        {#if value}<input type="hidden" {name} {value} />{/if}
      {/each}
      <Input
        name="q"
        value={q}
        placeholder="Username or user ID"
        aria-label="Search restrictions"
        class="h-9 flex-1 text-sm"
      />
      <Button type="submit" size="lg">Search</Button>
      {#if q}
        <Button href={clearSearchHref} variant="outline" size="lg">Clear</Button>
      {/if}
    </form>
  {/key}
</div>
