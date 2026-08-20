<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import type { SvelteSet } from 'svelte/reactivity';
  import * as Popover from '@civitai/ui/components/ui/popover/index.js';
  import { browsingLevels, getBrowsingLevelLabel, NsfwLevel } from '@civitai/shared';

  let {
    title,
    level,
    tagIds,
    excludedTagIds,
    tagOptions,
    itemKeys,
    selected,
  }: {
    title: string;
    level: number;
    tagIds: number[];
    excludedTagIds: number[];
    tagOptions: { id: number; name: string }[];
    /** Every card key on screen — the select-all set. */
    itemKeys: (string | number)[];
    selected: SvelteSet<string | number>;
  } = $props();

  // Moderators filter on Blocked too (a mis-rated image can carry the Blocked bit).
  const filterLevels = [...browsingLevels, NsfwLevel.Blocked];
  const allSelected = $derived(itemKeys.length > 0 && selected.size === itemKeys.length);

  const go = (url: URL) => {
    url.searchParams.delete('cursor');
    goto(url.pathname + url.search);
  };

  function toggleLevel(bit: number) {
    const url = new URL(page.url);
    url.searchParams.set('level', String(level ^ bit));
    go(url);
  }

  // Include/exclude a review tag (mutually exclusive per tag; toggles off when re-clicked). URL-driven.
  function toggleTag(id: number, mode: 'include' | 'exclude') {
    const inc = new Set(tagIds);
    const exc = new Set(excludedTagIds);
    const [self, other] = mode === 'include' ? [inc, exc] : [exc, inc];
    other.delete(id);
    if (self.has(id)) self.delete(id);
    else self.add(id);
    const url = new URL(page.url);
    for (const [key, set] of [
      ['tags', inc],
      ['notags', exc],
    ] as const)
      set.size ? url.searchParams.set(key, [...set].join(',')) : url.searchParams.delete(key);
    go(url);
  }

  const chip = 'rounded border px-2 py-1 text-xs font-semibold transition';
  const off = 'border-dark-4 text-dark-2 hover:border-dark-2';
</script>

<header class="page-header flex flex-wrap items-center justify-between gap-2">
  <h1>{title}</h1>
  <div class="flex items-center gap-1">
    {#if itemKeys.length > 0}
      <button
        class="{chip} {off}"
        onclick={() => {
          if (allSelected) selected.clear();
          else for (const key of itemKeys) selected.add(key);
        }}
      >
        {allSelected ? 'Deselect all' : `Select all ${itemKeys.length}`}
      </button>
    {/if}
    {#each filterLevels as bit (bit)}
      <button
        class="{chip} {(level & bit) !== 0
          ? 'border-primary bg-primary text-primary-foreground'
          : off}"
        onclick={() => toggleLevel(bit)}
      >
        {getBrowsingLevelLabel(bit)}
      </button>
    {/each}

    {#if tagOptions.length > 0}
      {@const activeCount = tagIds.length + excludedTagIds.length}
      <Popover.Root>
        <Popover.Trigger class="{chip} {off}">
          Tags{activeCount > 0 ? ` (${activeCount})` : ''}
        </Popover.Trigger>
        <Popover.Content align="end" class="max-h-[60vh] w-64 overflow-y-auto">
          <p class="mb-1 text-xs font-semibold uppercase text-dark-2">Filter by review tag</p>
          <div class="flex flex-col gap-0.5">
            {#each tagOptions as tag (tag.id)}
              {@const inc = tagIds.includes(tag.id)}
              {@const exc = excludedTagIds.includes(tag.id)}
              <div class="flex items-center gap-2 text-xs">
                <span class="flex-1 truncate">{tag.name}</span>
                <button
                  title="Include"
                  onclick={() => toggleTag(tag.id, 'include')}
                  class="rounded border px-1.5 font-semibold transition {inc
                    ? 'border-emerald-600 bg-emerald-600 text-white'
                    : 'border-dark-4 text-emerald-500 hover:bg-emerald-500/10'}">+</button
                >
                <button
                  title="Exclude"
                  onclick={() => toggleTag(tag.id, 'exclude')}
                  class="rounded border px-1.5 font-semibold transition {exc
                    ? 'border-rose-600 bg-rose-600 text-white'
                    : 'border-dark-4 text-rose-500 hover:bg-rose-500/10'}">−</button
                >
              </div>
            {/each}
          </div>
        </Popover.Content>
      </Popover.Root>
    {/if}
  </div>
</header>
