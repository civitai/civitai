<script lang="ts">
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import * as Dialog from '@civitai/ui/components/ui/dialog/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import { Label } from '@civitai/ui/components/ui/label/index.js';
  import { Switch } from '@civitai/ui/components/ui/switch/index.js';
  import { createVirtualizer } from '@tanstack/svelte-virtual';
  import { untrack } from 'svelte';
  import CosmeticSample from '$lib/components/CosmeticSample.svelte';
  import type { GrantBadge } from './user-account';

  const TILE_MIN_WIDTH = 120;
  // Must match the tiles' `h-34`.
  const TILE_HEIGHT = 136;
  const GAP = 8;

  let {
    badges,
    value = $bindable(''),
    disabled = false,
  }: { badges: GrantBadge[]; value?: string; disabled?: boolean } = $props();

  let open = $state(false);
  let query = $state('');
  let hideOwned = $state(false);

  const selected = $derived(badges.find((b) => String(b.id) === value) ?? null);
  const ownedCount = $derived(badges.filter((b) => b.owned).length);
  const shown = $derived.by(() => {
    const q = query.trim().toLowerCase();
    return badges.filter(
      (b) =>
        !(hideOwned && b.owned) &&
        (!q || b.name.toLowerCase().includes(q) || String(b.id) === q)
    );
  });

  let scrollEl = $state<HTMLDivElement | null>(null);
  let width = $state(0);
  const cols = $derived(Math.max(1, Math.floor((width + GAP) / (TILE_MIN_WIDTH + GAP))));
  const rows = createVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: 0,
    getScrollElement: () => scrollEl,
    estimateSize: () => TILE_HEIGHT + GAP,
    overscan: 3,
  });
  // `void scrollEl`: re-run when the dialog mounts the scroll element (it is only read untracked below).
  // setOptions alone does not publish a new count; measure() does. `$rows` is untracked because that
  // publish would re-run this effect.
  $effect(() => {
    const count = Math.ceil(shown.length / cols);
    void scrollEl;
    untrack(() => {
      $rows.setOptions({ count });
      $rows.measure();
    });
  });

  const resetScroll = () => scrollEl?.scrollTo({ top: 0 });

  function pick(badge: GrantBadge) {
    if (badge.owned) return;
    value = String(badge.id);
    open = false;
  }
</script>

<Button
  type="button"
  variant="outline"
  size="sm"
  class="h-auto min-h-8 min-w-56 flex-1 justify-start gap-2 py-1"
  {disabled}
  onclick={() => {
    query = '';
    open = true;
  }}
>
  {#if selected}
    <CosmeticSample type="Badge" name={selected.name} data={selected.data} />
    <span class="truncate">{selected.name}</span>
  {:else}
    <span class="text-dark-2">Choose a badge…</span>
  {/if}
</Button>

<Dialog.Root bind:open>
  <Dialog.Content class="flex max-h-[85vh] flex-col sm:max-w-3xl">
    <Dialog.Header>
      <Dialog.Title>Choose a badge</Dialog.Title>
      <Dialog.Description>
        Newest first. Badges this account already holds are marked Owned and cannot be picked.
      </Dialog.Description>
    </Dialog.Header>
    <div class="flex flex-wrap items-center gap-3">
      <Input
        bind:value={query}
        oninput={resetScroll}
        placeholder="Badge name or id…"
        aria-label="Filter badges"
        class="min-w-48 flex-1"
      />
      <div class="flex items-center gap-2">
        <Switch id="badge-hide-owned" bind:checked={hideOwned} onCheckedChange={resetScroll} />
        <Label for="badge-hide-owned" class="text-xs">Hide owned ({ownedCount})</Label>
      </div>
    </div>
    <div bind:this={scrollEl} bind:clientWidth={width} class="h-[60vh] overflow-y-auto">
      {#if shown.length === 0}
        <p class="py-6 text-center text-sm text-dark-2">No badge matches.</p>
      {:else}
        <!-- role=list on the wrapper; the absolutely placed rows are presentation only. -->
        <div
          role="list"
          aria-label="Badges"
          class="relative w-full"
          style:height="{$rows.getTotalSize()}px"
        >
          {#each $rows.getVirtualItems() as row (row.key)}
            <div
              role="presentation"
              class="absolute left-0 top-0 grid w-full gap-2"
              style:transform="translateY({row.start}px)"
              style:grid-template-columns="repeat({cols}, minmax(0, 1fr))"
            >
              {#each shown.slice(row.index * cols, (row.index + 1) * cols) as b (b.id)}
                <div role="listitem" class="h-34">
                  <!-- aria-disabled, not disabled: an owned tile stays focusable so it is announced. -->
                  <button
                    type="button"
                    onclick={() => pick(b)}
                    aria-disabled={b.owned}
                    aria-pressed={String(b.id) === value}
                    class="relative flex h-full w-full flex-col items-center gap-1.5 rounded-lg border p-2 text-center
                      {b.owned
                      ? 'cursor-not-allowed border-emerald-600/60 bg-emerald-950/30'
                      : 'border-dark-4 bg-dark-6 hover:border-blue-500 aria-pressed:border-blue-500 aria-pressed:bg-dark-5'}"
                  >
                    {#if b.owned}
                      <Badge class="absolute right-1 top-1 bg-emerald-600 text-white">Owned</Badge>
                    {/if}
                    <span class="flex h-16 items-center">
                      <CosmeticSample type="Badge" name={b.name} data={b.data} />
                    </span>
                    <span class="line-clamp-2 text-xs text-dark-0">{b.name}</span>
                    <span class="text-xs tabular-nums text-dark-2">#{b.id}</span>
                  </button>
                </div>
              {/each}
            </div>
          {/each}
        </div>
      {/if}
    </div>
  </Dialog.Content>
</Dialog.Root>
