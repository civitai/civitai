<script lang="ts">
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import { num } from '$lib/format';
  import { CATALOG_PAGE, NO_EVENT, type CatalogFilters, type CosmeticEvent, type ShelfBand } from '$lib/box-design';
  import type { PriceBands } from '$lib/box-flow';
  import Chip from './Chip.svelte';
  import { teamColor } from './teams';

  let {
    filters = $bindable(),
    hideInBox = $bindable(),
    events,
    bands,
  }: { filters: CatalogFilters; hideInBox: boolean; events: CosmeticEvent[]; bands: PriceBands } = $props();

  const TYPES = [
    ['ContentDecoration', 'Decoration'],
    ['Badge', 'Badge'],
    ['ProfileDecoration', 'Frame'],
    ['ProfileBackground', 'Background'],
    ['Sticker', 'Sticker'],
    ['NamePlate', 'Name plate'],
    ['CardDecoration', 'Card decoration'],
    ['ChatTheme', 'Chat theme'],
  ] as const;

  let showFilters = $state(false);
  let searchTimer: ReturnType<typeof setTimeout> | undefined;

  /** A filter change starts the list over at one page. */
  const filter = (patch: Partial<CatalogFilters>) => (filters = { ...filters, ...patch, limit: CATALOG_PAGE });
  const onSearch = (event: Event & { currentTarget: HTMLInputElement }) => {
    const value = event.currentTarget.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => filter({ q: value }), 250);
  };
  $effect(() => () => clearTimeout(searchTimer));

  const activeTeams = $derived(
    filters.event && filters.event !== NO_EVENT
      ? (events.find((entry) => entry.event === filters.event)?.teams ?? [])
      : [...new Set(events.flatMap((entry) => entry.teams))].sort()
  );
  const activeCount = $derived(
    (filters.event ? 1 : 0) + filters.types.length + (filters.team ? 1 : 0) + (filters.band ? 1 : 0) + (filters.needsDefinition ? 1 : 0)
  );
  const bandLabels = $derived<[ShelfBand, string][]>([
    ['', 'Any'],
    ['uncommon', `Up to ${num(bands.uncommon)}`],
    ['rare', `${num(bands.uncommon + 1)} to ${num(bands.rare)}`],
    ['legendary', `Over ${num(bands.rare)}`],
    ['none', 'No shelf price'],
  ]);
</script>

{#snippet group(label: string, content: import('svelte').Snippet)}
  <div>
    <div class="mb-1 text-xs tracking-wide text-dark-2 uppercase">{label}</div>
    <div class="flex flex-wrap gap-1.5">{@render content()}</div>
  </div>
{/snippet}

<div class="rounded-xl border border-dark-4 bg-dark-6 p-5">
  <div class="flex items-center gap-2">
    <Input type="search" class="flex-1" placeholder="Search cosmetics by name" aria-label="Search cosmetics by name" value={filters.q} oninput={onSearch} />
    <Button variant="outline" class="xl:hidden" aria-expanded={showFilters} onclick={() => (showFilters = !showFilters)}>
      Filters{activeCount ? ` · ${activeCount}` : ''}
    </Button>
  </div>

  <div class="mt-3 gap-x-6 gap-y-3 xl:grid xl:grid-cols-2 {showFilters ? 'grid' : 'hidden xl:grid'}">
    {#snippet events_()}
      <Chip pressed={filters.event === ''} onclick={() => filter({ event: '', team: '' })}>All</Chip>
      {#each events as { event } (event)}
        <Chip pressed={filters.event === event} onclick={() => filter({ event: filters.event === event ? '' : event, team: '' })}>{event}</Chip>
      {/each}
      <Chip pressed={filters.event === NO_EVENT} onclick={() => filter({ event: filters.event === NO_EVENT ? '' : NO_EVENT, team: '' })}>No event</Chip>
    {/snippet}
    {@render group('Event', events_)}

    {#snippet types_()}
      {#each TYPES as [type, label] (type)}
        <Chip
          pressed={filters.types.includes(type)}
          onclick={() => filter({ types: filters.types.includes(type) ? filters.types.filter((t) => t !== type) : [...filters.types, type] })}
        >{label}</Chip>
      {/each}
    {/snippet}
    {@render group('Type', types_)}

    {#if activeTeams.length}
      {#snippet teams_()}
        <Chip pressed={filters.team === ''} onclick={() => filter({ team: '' })}>Any</Chip>
        {#each activeTeams as team (team)}
          <Chip pressed={filters.team === team} onclick={() => filter({ team: filters.team === team ? '' : team })}>
            <span class="size-2 rounded-full" style:background-color={teamColor(team)}></span>{team}
          </Chip>
        {/each}
      {/snippet}
      {@render group('Made for team', teams_)}
    {/if}

    {#snippet band_()}
      {#each bandLabels as [band, label] (band)}
        <Chip pressed={filters.band === band} onclick={() => filter({ band })}>{label}</Chip>
      {/each}
    {/snippet}
    {@render group('Shelf price (Buzz)', band_)}

    {#snippet show_()}
      <Chip pressed={hideInBox} onclick={() => (hideInBox = !hideInBox)}>Not in the box</Chip>
      <Chip pressed={filters.needsDefinition} onclick={() => filter({ needsDefinition: !filters.needsDefinition })}>Needs a definition</Chip>
    {/snippet}
    {@render group('Show', show_)}
  </div>
</div>
