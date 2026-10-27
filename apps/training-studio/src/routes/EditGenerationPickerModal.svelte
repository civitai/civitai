<script lang="ts">
  import { SvelteSet } from 'svelte/reactivity';
  import { IconArrowRight, IconCheck, IconPhoto } from '@tabler/icons-svelte';
  import { backend, browser, portalProps } from '$lib/host';
  import type { EditGenerationItem } from '$lib/edit-helpers-core';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Spinner } from '@civitai/ui/components/ui/spinner/index.js';
  import * as Dialog from '@civitai/ui/components/ui/dialog/index.js';

  let {
    open = $bindable(false),
    onAdd,
  }: {
    open: boolean;
    onAdd: (items: EditGenerationItem[]) => void;
  } = $props();

  // Each opening refetches: the caller may have generated edits since.
  const itemsPromise = $derived(open && browser ? backend().listEditGenerations() : null);
  const selected = new SvelteSet<string>();
  // A source that can't be shown directly falls back to a placeholder; the pair reads its bytes with
  // the workflow's authorisation instead.
  const brokenSources = new SvelteSet<string>();
  $effect(() => {
    if (open) selected.clear();
  });

  function toggle(id: string) {
    if (selected.has(id)) selected.delete(id);
    else selected.add(id);
  }

  function add(items: EditGenerationItem[]) {
    const chosen = items.filter((i) => selected.has(i.resultBlobId));
    if (chosen.length) onAdd(chosen);
    open = false;
  }
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="sm:max-w-3xl" portalProps={portalProps()}>
    <Dialog.Header>
      <Dialog.Title>From my edit generations</Dialog.Title>
      <Dialog.Description>
        Pick edits you made in the Generator. Each brings its starting image, the result and your
        prompt as a ready pair.
      </Dialog.Description>
    </Dialog.Header>

    {#if itemsPromise}
      {#await itemsPromise}
        <div class="flex items-center justify-center gap-2 py-16 text-sm text-dark-2">
          <Spinner class="size-4" /> Loading your edits…
        </div>
      {:then items}
        {#if items.length === 0}
          <div class="py-16 text-center text-sm text-dark-2">
            No single-image edits in the last 30 days. Edit an image in the Generator, or upload your
            pairs instead.
          </div>
        {:else}
          <div class="mb-2 text-xs text-dark-2" aria-live="polite">
            {selected.size} of {items.length} selected
          </div>
          <div
            class="grid max-h-[60vh] grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3 overflow-y-auto p-0.5"
            role="group"
            aria-label="Your edit generations"
          >
            {#each items as item (item.resultBlobId)}
              {@const isSelected = selected.has(item.resultBlobId)}
              <button
                type="button"
                aria-pressed={isSelected}
                onclick={() => toggle(item.resultBlobId)}
                class="relative flex flex-col overflow-hidden rounded-lg border bg-dark-7 text-left {isSelected
                  ? 'border-primary ring-2 ring-primary'
                  : 'border-dark-4 hover:border-dark-2'}"
              >
                <div class="grid grid-cols-[1fr_auto_1fr] items-center gap-1 p-1.5">
                  <div class="aspect-square overflow-hidden rounded bg-dark-6">
                    {#if brokenSources.has(item.sourceUrl)}
                      <span class="flex h-full w-full items-center justify-center text-dark-2">
                        <IconPhoto size={22} stroke={1.5} />
                      </span>
                    {:else}
                      <img
                        src={item.sourceUrl}
                        alt=""
                        loading="lazy"
                        onerror={() => brokenSources.add(item.sourceUrl)}
                        class="h-full w-full object-cover"
                      />
                    {/if}
                  </div>
                  <IconArrowRight size={14} stroke={2} class="text-dark-2" aria-hidden="true" />
                  <div class="aspect-square overflow-hidden rounded bg-dark-6">
                    <img src={item.previewUrl} alt="" loading="lazy" class="h-full w-full object-cover" />
                  </div>
                </div>
                <span class="line-clamp-2 px-2.5 pb-2 text-xs text-dark-0">{item.prompt}</span>
                {#if isSelected}
                  <span class="absolute right-1.5 top-1.5 grid h-5 w-5 place-items-center rounded-full bg-primary text-primary-foreground">
                    <IconCheck size={12} stroke={3} />
                  </span>
                {/if}
              </button>
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
            {selected.size ? `Add ${selected.size} ${selected.size === 1 ? 'pair' : 'pairs'}` : 'Select edits'}
          </Button>
        </Dialog.Footer>
      {:catch err}
        <div class="py-16 text-center text-sm text-red-400">
          {err instanceof Error ? err.message : 'Could not load your edits.'}
        </div>
      {/await}
    {/if}
  </Dialog.Content>
</Dialog.Root>
