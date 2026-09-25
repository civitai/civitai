<script lang="ts">
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { IconPencil, IconX } from '@tabler/icons-svelte';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import * as Dialog from '@civitai/ui/components/ui/dialog/index.js';
  import { portalProps } from '$lib/host';
  import { splitTags, type Img } from './trainingFlow';

  // Dataset-wide rename/remove of one tag. `images` is the flow's own state proxy, so mutating a
  // tile's tags here applies live to the grid (the label editor's contract). Exact-string tag
  // identity — the rows come from the stored tags themselves.
  let {
    open = $bindable(false),
    tagFreq,
    images,
  }: {
    open: boolean;
    /** [tag, occurrence count], frequency-ranked (DataStep's tagFreq). */
    tagFreq: [string, number][];
    images: Img[];
  } = $props();

  let renameFrom = $state<string | null>(null);
  let renameDraft = $state('');

  function startTagRename(tag: string) {
    renameFrom = tag;
    renameDraft = tag;
  }
  function applyTagRename() {
    const from = renameFrom;
    const to = splitTags(renameDraft);
    renameFrom = null;
    if (!from || to.length === 0 || (to.length === 1 && to[0] === from)) return;
    for (const img of images) {
      if (!img.tags.includes(from)) continue;
      // Map in place (keeps the tag's position) and dedupe in case a target already exists.
      const seen = new Set<string>();
      const next: string[] = [];
      for (const t of img.tags) {
        for (const mapped of t === from ? to : [t]) {
          if (!seen.has(mapped)) {
            seen.add(mapped);
            next.push(mapped);
          }
        }
      }
      img.tags = next;
    }
  }
  function removeTagEverywhere(tag: string) {
    for (const img of images) {
      if (img.tags.includes(tag)) img.tags = img.tags.filter((t) => t !== tag);
    }
  }
</script>

<Dialog.Root
  bind:open={
    () => open,
    (v) => {
      open = v;
      // An inline rename left open must not ride onto the next opening.
      if (!v) renameFrom = null;
    }
  }
>
  <Dialog.Content class="sm:max-w-md" portalProps={portalProps()}>
    <Dialog.Header>
      <Dialog.Title>Manage tags</Dialog.Title>
      <Dialog.Description>
        Rename or remove a tag across the whole dataset. Changes apply immediately.
      </Dialog.Description>
    </Dialog.Header>
    {#if tagFreq.length === 0}
      <p class="font-mono text-xs text-dark-2">No tags in this dataset.</p>
    {:else}
      <ul class="m-0 flex max-h-[50vh] list-none flex-col gap-1 overflow-y-auto p-0">
        {#each tagFreq as [tag, count] (tag)}
          <li class="flex items-center gap-2 rounded border border-dark-4 bg-dark-7 px-2.5 py-1.5">
            {#if renameFrom === tag}
              <form
                class="flex flex-1 items-center gap-2"
                onsubmit={(e) => {
                  e.preventDefault();
                  applyTagRename();
                }}
              >
                <Input
                  bind:value={renameDraft}
                  aria-label="New name for {tag}"
                  class="h-7 flex-1 font-mono text-xs"
                />
                <Button type="submit" size="xs" disabled={!renameDraft.trim()}>Save</Button>
                <Button type="button" variant="ghost" size="xs" onclick={() => (renameFrom = null)}>
                  Cancel
                </Button>
              </form>
            {:else}
              <span class="min-w-0 flex-1 truncate font-mono text-xs text-dark-0" title={tag}>
                {tag}
              </span>
              <span class="shrink-0 font-mono text-xs text-dark-2">
                {count} image{count === 1 ? '' : 's'}
              </span>
              <button
                type="button"
                aria-label="Rename {tag} everywhere"
                onclick={() => startTagRename(tag)}
                class="grid h-6 w-6 shrink-0 place-items-center rounded text-dark-2 transition-colors hover:bg-dark-5 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                <IconPencil size={13} stroke={2} />
              </button>
              <button
                type="button"
                aria-label="Remove {tag} from every image"
                onclick={() => removeTagEverywhere(tag)}
                class="grid h-6 w-6 shrink-0 place-items-center rounded text-dark-2 transition-colors hover:bg-red-500/15 hover:text-red-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                <IconX size={13} stroke={2} />
              </button>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </Dialog.Content>
</Dialog.Root>
