<script lang="ts">
  import { browser } from '$app/environment';
  import { SvelteSet } from 'svelte/reactivity';
  import { IconMusic, IconCheck } from '@tabler/icons-svelte';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Spinner } from '@civitai/ui/components/ui/spinner/index.js';
  import * as Dialog from '@civitai/ui/components/ui/dialog/index.js';
  import type { Media } from '$lib/data/trainingModels';
  import type { GenerationItem } from '$lib/data/trainingRows';

  let {
    open = $bindable(false),
    media,
    onAdd,
  }: {
    open: boolean;
    media: Media;
    onAdd: (items: GenerationItem[]) => void;
  } = $props();

  // Derive the promise from `open` so each open (false→true) refetches — generations change between visits.
  const itemsPromise = $derived(
    open && browser
      ? fetch(`/api/generations?media=${media}`).then(async (r) => {
          if (!r.ok) {
            const body = (await r.json().catch(() => null)) as { message?: string } | null;
            throw new Error(body?.message ?? `Failed to load generations (${r.status})`);
          }
          return ((await r.json()) as { items: GenerationItem[] }).items;
        })
      : null
  );

  const selected = new SvelteSet<string>();
  // Anchor for shift-click range selection — the last plain-clicked tile.
  let anchor = $state<number | null>(null);
  $effect(() => {
    if (open) {
      selected.clear();
      anchor = null;
    }
  });

  // Plain click toggles one and moves the anchor; shift-click adds the contiguous range from the anchor
  // (standard grid multi-select). With no anchor yet, shift behaves like a plain click.
  function pick(event: MouseEvent | KeyboardEvent, index: number, items: GenerationItem[]) {
    if (event.shiftKey && anchor !== null) {
      const [lo, hi] = anchor < index ? [anchor, index] : [index, anchor];
      for (let i = lo; i <= hi; i++) selected.add(items[i].blobId);
      return;
    }
    const id = items[index].blobId;
    if (selected.has(id)) selected.delete(id);
    else selected.add(id);
    anchor = index;
  }

  function selectAll(items: GenerationItem[]) {
    for (const item of items) selected.add(item.blobId);
  }
  function clear() {
    selected.clear();
    anchor = null;
  }

  function add(items: GenerationItem[]) {
    const chosen = items.filter((i) => selected.has(i.blobId));
    if (chosen.length) onAdd(chosen);
    open = false;
  }
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="sm:max-w-3xl">
    <Dialog.Header>
      <Dialog.Title>From my generations</Dialog.Title>
      <Dialog.Description>
        Pick {media === 'audio' ? 'clips' : media === 'video' ? 'videos' : 'images'} you've generated to add
        to this dataset. They're already scanned, so they skip upload.
      </Dialog.Description>
    </Dialog.Header>

    {#if itemsPromise}
      {#await itemsPromise}
        <div class="flex items-center justify-center gap-2 py-16 text-sm text-dark-2">
          <Spinner class="size-4" /> Loading your generations…
        </div>
      {:then items}
        {#if items.length === 0}
          <div class="py-16 text-center text-sm text-dark-2">
            No generated {media === 'image' ? 'images' : media === 'video' ? 'videos' : 'audio'} in the last 30
            days. Generate some, or upload files instead.
          </div>
        {:else}
          <div class="mb-2 flex items-center justify-between gap-2 text-xs text-dark-2">
            <span aria-live="polite">{selected.size} of {items.length} selected · shift-click for a range</span>
            <div class="flex gap-1">
              <Button variant="ghost" size="xs" onclick={() => selectAll(items)}>Select all</Button>
              <Button variant="ghost" size="xs" onclick={clear} disabled={selected.size === 0}>Clear</Button>
            </div>
          </div>
          <!-- Fixed square cells (fixed columns AND rows). aspect-ratio on the tile does NOT work here: an
               aspect-ratio box contributes 0 to grid auto-row track sizing, so rows collapse and the 1:1
               tiles overlap into strips. Fixed rows size the tracks; the tile stretches to fill the cell. -->
          <div
            class="grid max-h-[60vh] select-none grid-cols-[repeat(auto-fill,128px)] justify-center gap-2.5 overflow-y-auto p-0.5 [grid-auto-rows:128px]"
            role="group"
            aria-label="Your generations"
          >
            {#each items as item, index (item.blobId)}
              {@const isSelected = selected.has(item.blobId)}
              <div
                role="button"
                tabindex="0"
                aria-pressed={isSelected}
                aria-label={`${media} ${index + 1}`}
                onclick={(e) => pick(e, index, items)}
                onkeydown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    pick(e, index, items);
                  }
                }}
                class="relative cursor-pointer overflow-hidden rounded-md border bg-dark-8 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary {isSelected
                  ? 'border-primary ring-2 ring-primary'
                  : 'border-dark-4 hover:border-dark-2'}"
              >
                {#if media === 'video'}
                  <!-- svelte-ignore a11y_media_has_caption -->
                  <video src={item.url} muted playsinline class="h-full w-full object-cover"></video>
                {:else if media === 'audio'}
                  <span class="flex h-full w-full items-center justify-center text-dark-2">
                    <IconMusic size={26} stroke={2} />
                  </span>
                {:else}
                  <img src={item.previewUrl} alt="" loading="lazy" class="h-full w-full object-cover" />
                {/if}
                {#if isSelected}
                  <span
                    class="absolute right-1 top-1 grid h-5 w-5 place-items-center rounded-full bg-primary text-black"
                  >
                    <IconCheck size={12} stroke={3} />
                  </span>
                {/if}
              </div>
            {/each}
          </div>
        {/if}

        <Dialog.Footer>
          <Dialog.Close>
            {#snippet child({ props })}
              <Button {...props} variant="ghost">Cancel</Button>
            {/snippet}
          </Dialog.Close>
          <Button onclick={() => add(items)} disabled={selected.size === 0}>
            Add {selected.size || ''}
          </Button>
        </Dialog.Footer>
      {:catch err}
        <div class="py-16 text-center text-sm text-red-400">
          {err instanceof Error ? err.message : 'Could not load your generations.'}
        </div>
      {/await}
    {/if}
  </Dialog.Content>
</Dialog.Root>
