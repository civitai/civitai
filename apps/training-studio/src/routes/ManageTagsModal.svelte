<script lang="ts">
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import {
    IconArrowBackUp,
    IconArrowMerge,
    IconFilter,
    IconPencil,
    IconPlus,
    IconX,
  } from '@tabler/icons-svelte';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import { Checkbox } from '@civitai/ui/components/ui/checkbox/index.js';
  import * as Dialog from '@civitai/ui/components/ui/dialog/index.js';
  import * as Select from '@civitai/ui/components/ui/select/index.js';
  import { portalProps } from '$lib/host';
  import { mediaCount, type Media } from '$lib/data/trainingModels';
  import { datasetBatches, imagesInScope, splitTags, type Img } from './trainingFlow';
  import { groupTags, planReplace, prependTags, removeTag, renameTag, type TagGroup } from './tagReplace';

  // Edits over the whole dataset or one batch: add/rename/remove one tag, and find-and-replace inside tags.
  // `images` is the flow's own state proxy, so mutating a tile's tags here applies live to the grid (the label
  // editor's contract). A per-tag row is every casing of that tag, so its rename and remove apply to all of
  // them. Every change is undoable once: a dataset-wide edit that lands wrong has no other way back.
  let {
    open = $bindable(false),
    tagGroups,
    images,
    media,
    findReplace = false,
    onShowTag,
  }: {
    open: boolean;
    tagGroups: TagGroup[];
    images: Img[];
    media: Media;
    /** Show the find-and-replace row (its Flipt gate; off by default). */
    findReplace?: boolean;
    /** Filters the dataset grid to the images carrying this tag. */
    onShowTag: (tag: string) => void;
  } = $props();

  let renameFrom = $state<string | null>(null);
  let renameDraft = $state('');
  let addDraft = $state('');
  let findDraft = $state('');
  let replaceDraft = $state('');
  let useRegex = $state(false);
  let matchCase = $state(false);
  // A batch id, or null for the whole dataset. A batch whose images were all removed falls back to the whole
  // dataset rather than leaving every action a no-op.
  let scope = $state<number | null>(null);
  const batches = $derived(datasetBatches(images, media));
  const batchId = $derived(batches.some((b) => b.id === scope) ? scope : null);
  const scoped = $derived(imagesInScope(images, batchId));
  const scopedTagGroups = $derived(batchId === null ? tagGroups : groupTags(scoped));

  // Keyed by image id, never index, so an image removed from the dataset in between simply drops
  // out of the restore.
  let lastChange = $state<{ summary: string; before: Map<number, string[]> } | null>(null);

  const trainableWithTags = $derived(scoped.filter((i) => i.tags.length > 0).length);

  const plan = $derived(
    findReplace
      ? planReplace(scoped, { find: findDraft, replace: replaceDraft, regex: useRegex, matchCase })
      : null
  );
  const affected = $derived(plan && !plan.error ? plan.changes.length : 0);
  const emptied = $derived(plan && !plan.error ? plan.emptied : 0);

  function record(summary: string, touched: Img[]) {
    lastChange = { summary, before: new Map(touched.map((img) => [img.id, [...img.tags]])) };
  }
  function undo() {
    if (!lastChange) return;
    for (const img of images) {
      const tags = lastChange.before.get(img.id);
      if (tags) img.tags = tags;
    }
    lastChange = null;
  }

  // An inline rename or find text left open must not ride onto the next opening; neither should a stale Undo.
  function resetDrafts() {
    scope = null;
    renameFrom = null;
    lastChange = null;
    findDraft = '';
    replaceDraft = '';
  }

  function applyReplace() {
    if (!plan || plan.error || plan.changes.length === 0) return;
    const after = new Map(plan.changes.map((c) => [c.id, c.after]));
    const touched = scoped.filter((img) => after.has(img.id));
    record(
      `Replaced "${findDraft}" with "${replaceDraft}" on ${mediaCount(touched.length, media)}`,
      touched
    );
    for (const img of touched) img.tags = after.get(img.id)!;
    findDraft = '';
    replaceDraft = '';
  }

  function startTagRename(tag: string) {
    renameFrom = tag;
    renameDraft = tag;
  }
  function applyTagRename() {
    const from = renameFrom;
    renameFrom = null;
    const to = splitTags(renameDraft);
    // Saving the name unchanged is a cancel; merging casings is the Merge button's job.
    if (from && !(to.length === 1 && to[0] === from)) renameEverywhere(from, to, 'Renamed');
  }
  function renameEverywhere(from: string, to: string[], verb: string) {
    if (to.length === 0) return;
    const after = new Map<number, string[]>();
    for (const img of scoped) {
      const next = renameTag(img.tags, from, to);
      if (next.length !== img.tags.length || next.some((t, i) => t !== img.tags[i])) after.set(img.id, next);
    }
    if (after.size === 0) return;
    const touched = scoped.filter((img) => after.has(img.id));
    record(`${verb} "${from}" to "${to.join(', ')}" on ${mediaCount(touched.length, media)}`, touched);
    for (const img of touched) img.tags = after.get(img.id)!;
  }
  function removeTagEverywhere(tag: string) {
    const touched = scoped.filter((img) => removeTag(img.tags, tag).length !== img.tags.length);
    record(`Removed "${tag}" from ${mediaCount(touched.length, media)}`, touched);
    for (const img of touched) img.tags = removeTag(img.tags, tag);
  }
  // Prepended — where a trigger-like tag belongs. Unlabeled images are skipped: a tag alone is not a
  // label, and auto-label would overwrite it.
  function addTagEverywhere() {
    const tags = splitTags(addDraft);
    addDraft = '';
    if (tags.length === 0) return;
    const touched = scoped.filter(
      (img) => img.tags.length > 0 && prependTags(img.tags, tags) !== img.tags
    );
    if (touched.length === 0) return;
    record(`Added "${tags.join(', ')}" to ${mediaCount(touched.length, media)}`, touched);
    for (const img of touched) img.tags = prependTags(img.tags, tags);
  }
</script>

<Dialog.Root
  bind:open={
    () => open,
    (v) => {
      open = v;
      if (!v) resetDrafts();
    }
  }
>
  <!-- Capped to the visible height with only the tag list shrinking, so a long list or the Undo bar can't
       push the header and close ✕ off a portrait screen. dvh: mobile browser chrome makes vh too tall. -->
  <Dialog.Content class="flex max-h-[calc(100dvh-2rem)] flex-col sm:max-w-md" portalProps={portalProps()}>
    <Dialog.Header>
      <Dialog.Title>Manage tags</Dialog.Title>
      <Dialog.Description>
        Add, rename or remove a tag across {batchId === null ? 'the whole dataset' : 'one batch'}.
        Changes apply immediately and the last one can be undone.
      </Dialog.Description>
    </Dialog.Header>
    {#if batches.length > 1}
      <Select.Root
        type="single"
        bind:value={
          () => (batchId === null ? 'all' : String(batchId)),
          (v) => (scope = v === 'all' ? null : Number(v))
        }
      >
        <Select.Trigger class="h-8 w-full min-w-0 font-mono text-xs" aria-label="Apply tag edits to">
          <span class="min-w-0 truncate">
            {batches.find((b) => b.id === batchId)?.label ?? 'Whole dataset'}
          </span>
        </Select.Trigger>
        <Select.Content portalProps={portalProps()}>
          <Select.Item value="all">Whole dataset</Select.Item>
          {#each batches as b (b.id)}
            <Select.Item value={String(b.id)}>{b.label}</Select.Item>
          {/each}
        </Select.Content>
      </Select.Root>
    {/if}
    <form
      class="flex items-center gap-2"
      onsubmit={(e) => {
        e.preventDefault();
        addTagEverywhere();
      }}
    >
      <Input
        bind:value={addDraft}
        placeholder="Add a tag to every labeled image…"
        aria-label="Tag to add to every labeled image"
        class="h-8 flex-1 font-mono text-xs"
      />
      <Button type="submit" size="sm" variant="outline" disabled={!addDraft.trim() || trainableWithTags === 0}>
        <IconPlus size={13} stroke={2} class="mr-1 inline" />Add to all
      </Button>
    </form>
    {#if findReplace}
      <form
        class="flex flex-col gap-2 rounded-md border border-dark-4 bg-dark-7 p-2.5"
        aria-label="Find and replace in tags"
        onsubmit={(e) => {
          e.preventDefault();
          applyReplace();
        }}
      >
        <div class="flex flex-col gap-2 sm:flex-row">
          <Input
            bind:value={findDraft}
            placeholder={useRegex ? 'Find (regex)…' : 'Find in tags…'}
            aria-label="Text to find in tags"
            aria-invalid={plan?.error ? true : undefined}
            class="h-8 flex-1 font-mono text-xs"
          />
          <Input
            bind:value={replaceDraft}
            placeholder="Replace with (blank removes)…"
            aria-label="Replacement text"
            class="h-8 flex-1 font-mono text-xs"
          />
        </div>
        <div class="flex flex-wrap items-center gap-x-4 gap-y-1.5">
          <label class="inline-flex items-center gap-1.5 font-mono text-xs text-dark-2">
            <Checkbox bind:checked={useRegex} />
            Regex
          </label>
          <label class="inline-flex items-center gap-1.5 font-mono text-xs text-dark-2">
            <Checkbox bind:checked={matchCase} />
            Match case
          </label>
          <Button type="submit" size="sm" variant="outline" class="ml-auto" disabled={affected === 0}>
            Replace in all
          </Button>
        </div>
        {#if plan?.error}
          <p class="m-0 font-mono text-xs text-red-400" role="alert">{plan.error}</p>
        {:else if findDraft}
          <p class="m-0 font-mono text-xs text-dark-1" role="status">
            {affected === 0 ? 'No images affected' : `${mediaCount(affected, media)} affected`}
          </p>
        {/if}
        {#if emptied > 0}
          <p class="m-0 font-mono text-xs text-amber-400" role="status">
            {mediaCount(emptied, media)} would end up with no tags and become unlabeled.
          </p>
        {/if}
      </form>
    {/if}
    {#if scopedTagGroups.length === 0}
      <p class="font-mono text-xs text-dark-2">
        No tags in {batchId === null ? 'this dataset' : 'this batch'}.
      </p>
    {:else}
      <ul class="m-0 flex max-h-[50vh] min-h-0 list-none flex-col gap-1 overflow-y-auto p-0">
        {#each scopedTagGroups as { tag, count, variants } (tag)}
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
              <span
                class="min-w-0 flex-1 truncate font-mono text-xs text-dark-0"
                title={variants.join(', ')}
              >
                {tag}
                {#if variants.length > 1}
                  <span class="text-dark-2">+{variants.length - 1} casing{variants.length > 2 ? 's' : ''}</span>
                {/if}
              </span>
              <span class="shrink-0 font-mono text-xs text-dark-2">
                {count} / {trainableWithTags}
              </span>
              <button
                type="button"
                aria-label="Show everything tagged {tag}"
                title="Show everything tagged with this"
                onclick={() => {
                  onShowTag(tag);
                  open = false;
                  resetDrafts();
                }}
                class="grid h-6 w-6 shrink-0 place-items-center rounded text-dark-2 transition-colors hover:bg-dark-5 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                <IconFilter size={13} stroke={2} />
              </button>
              {#if variants.length > 1}
                <button
                  type="button"
                  aria-label="Merge {variants.join(', ')} into {tag}"
                  title="Write every casing as {tag}"
                  onclick={() => renameEverywhere(tag, [tag], 'Merged casings of')}
                  class="grid h-6 w-6 shrink-0 place-items-center rounded text-dark-2 transition-colors hover:bg-dark-5 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                >
                  <IconArrowMerge size={13} stroke={2} />
                </button>
              {/if}
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
    {#if lastChange}
      <div
        role="status"
        class="flex items-center gap-2 rounded-md border border-dark-4 bg-dark-7 px-2.5 py-1.5 font-mono text-xs text-dark-1"
      >
        <span class="min-w-0 flex-1 truncate" title={lastChange.summary}>{lastChange.summary}</span>
        <Button size="xs" variant="outline" onclick={undo}>
          <IconArrowBackUp size={13} stroke={2} class="mr-1 inline" />Undo
        </Button>
      </div>
    {/if}
  </Dialog.Content>
</Dialog.Root>
