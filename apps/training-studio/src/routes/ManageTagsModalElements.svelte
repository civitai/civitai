<script lang="ts">
  import '$lib/civitai-elements';
  import type { CivitaiCheckbox } from '@civitai/components/civitai-checkbox';
  import type { CivitaiTextInput } from '@civitai/components/civitai-text-input';
  import {
    IconArrowBackUp,
    IconArrowMerge,
    IconFilter,
    IconPencil,
    IconPlus,
    IconX,
  } from '@tabler/icons-svelte';
  import { mediaCount, type Media } from '$lib/data/trainingModels';
  import { splitTags, type Img } from './trainingFlow';
  import { planReplace, prependTags, removeTag, renameTag, type TagGroup } from './tagReplace';

  // Dataset-wide edits: add/rename/remove one tag, and find-and-replace inside tags. `images` is the flow's
  // own state proxy, so mutating a tile's tags here applies live to the grid (the label editor's contract).
  // A per-tag row is every casing of that tag, so its rename and remove apply to all of them. Every change
  // is undoable once: a dataset-wide edit that lands wrong has no other way back.
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

  // Keyed by image id, never index, so an image removed from the dataset in between simply drops
  // out of the restore.
  let lastChange = $state<{ summary: string; before: Map<number, string[]> } | null>(null);

  const trainableWithTags = $derived(images.filter((i) => i.tags.length > 0).length);

  const plan = $derived(
    findReplace
      ? planReplace(images, { find: findDraft, replace: replaceDraft, regex: useRegex, matchCase })
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
    renameFrom = null;
    lastChange = null;
    findDraft = '';
    replaceDraft = '';
  }

  function applyReplace() {
    if (!plan || plan.error || plan.changes.length === 0) return;
    const after = new Map(plan.changes.map((c) => [c.id, c.after]));
    const touched = images.filter((img) => after.has(img.id));
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
    for (const img of images) {
      const next = renameTag(img.tags, from, to);
      if (next.length !== img.tags.length || next.some((t, i) => t !== img.tags[i])) after.set(img.id, next);
    }
    if (after.size === 0) return;
    const touched = images.filter((img) => after.has(img.id));
    record(`${verb} "${from}" to "${to.join(', ')}" on ${mediaCount(touched.length, media)}`, touched);
    for (const img of touched) img.tags = after.get(img.id)!;
  }
  function removeTagEverywhere(tag: string) {
    const touched = images.filter((img) => removeTag(img.tags, tag).length !== img.tags.length);
    record(`Removed "${tag}" from ${mediaCount(touched.length, media)}`, touched);
    for (const img of touched) img.tags = removeTag(img.tags, tag);
  }
  // Prepended — where a trigger-like tag belongs. Unlabeled images are skipped: a tag alone is not a
  // label, and auto-label would overwrite it.
  function addTagEverywhere() {
    const tags = splitTags(addDraft);
    addDraft = '';
    if (tags.length === 0) return;
    const touched = images.filter(
      (img) => img.tags.length > 0 && prependTags(img.tags, tags) !== img.tags
    );
    if (touched.length === 0) return;
    record(`Added "${tags.join(', ')}" to ${mediaCount(touched.length, media)}`, touched);
    for (const img of touched) img.tags = prependTags(img.tags, tags);
  }
</script>

<!-- Capped to the visible height with only the tag list shrinking, so a long list or the Undo bar can't
     push the header and close ✕ off a portrait screen. dvh: mobile browser chrome makes vh too tall. -->
<civitai-modal
  {open}
  heading="Manage tags"
  with-close-button
  close-label="Close"
  onclose={() => {
    open = false;
    resetDrafts();
  }}
>
  <div class="flex max-h-[calc(100dvh-10rem)] flex-col gap-3">
    <p class="m-0 text-sm text-dark-2">
      Add, rename or remove a tag across the whole dataset. Changes apply immediately and the last
      one can be undone.
    </p>
    <form
      class="flex items-end gap-2"
      onsubmit={(e) => {
        e.preventDefault();
        // The kit fields submit on Enter even when the form's button is disabled.
        if (addDraft.trim() && trainableWithTags > 0) addTagEverywhere();
      }}
    >
      <civitai-text-input
        class="min-w-0 flex-1"
        size="sm"
        label="Add a tag to every labeled image"
        placeholder="tag"
        value={addDraft}
        oninput={(e: Event) => (addDraft = (e.currentTarget as CivitaiTextInput).value)}
      ></civitai-text-input>
      <civitai-button type="submit" size="sm" variant="outline" disabled={!addDraft.trim() || trainableWithTags === 0}>
        <span slot="left"><IconPlus size={13} stroke={2} /></span>Add to all
      </civitai-button>
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
          <civitai-text-input
            class="min-w-0 flex-1"
            size="sm"
            label={useRegex ? 'Find (regex)' : 'Find in tags'}
            value={findDraft}
            error={plan?.error ?? ''}
            oninput={(e: Event) => (findDraft = (e.currentTarget as CivitaiTextInput).value)}
          ></civitai-text-input>
          <civitai-text-input
            class="min-w-0 flex-1"
            size="sm"
            label="Replace with"
            placeholder="blank removes"
            value={replaceDraft}
            oninput={(e: Event) => (replaceDraft = (e.currentTarget as CivitaiTextInput).value)}
          ></civitai-text-input>
        </div>
        <div class="flex flex-wrap items-center gap-x-4 gap-y-1.5">
          <civitai-checkbox
            size="sm"
            label="Regex"
            checked={useRegex}
            onchange={(e: Event) => (useRegex = (e.currentTarget as CivitaiCheckbox).checked)}
          ></civitai-checkbox>
          <civitai-checkbox
            size="sm"
            label="Match case"
            checked={matchCase}
            onchange={(e: Event) => (matchCase = (e.currentTarget as CivitaiCheckbox).checked)}
          ></civitai-checkbox>
          <civitai-button type="submit" size="sm" variant="outline" class="ml-auto" disabled={affected === 0}>
            Replace in all
          </civitai-button>
        </div>
        {#if !plan?.error && findDraft}
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
    {#if tagGroups.length === 0}
      <p class="font-mono text-xs text-dark-2">No tags in this dataset.</p>
    {:else}
      <ul class="m-0 flex max-h-[50vh] min-h-0 list-none flex-col gap-1 overflow-y-auto p-0">
        {#each tagGroups as { tag, count, variants } (tag)}
          <li class="flex items-center gap-2 rounded border border-dark-4 bg-dark-7 px-2.5 py-1.5">
            {#if renameFrom === tag}
              <form
                class="flex flex-1 items-end gap-2"
                onsubmit={(e) => {
                  e.preventDefault();
                  if (renameDraft.trim()) applyTagRename();
                }}
              >
                <civitai-text-input
                  class="min-w-0 flex-1"
                  size="sm"
                  label="New name for {tag}"
                  value={renameDraft}
                  oninput={(e: Event) => (renameDraft = (e.currentTarget as CivitaiTextInput).value)}
                ></civitai-text-input>
                <civitai-button class="self-end" type="submit" size="sm" disabled={!renameDraft.trim()}>Save</civitai-button>
                <civitai-button class="self-end" variant="subtle" size="sm" onclick={() => (renameFrom = null)}>
                  Cancel
                </civitai-button>
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
              <studio-icon-button
                label="Show everything tagged {tag}"
                onclick={() => {
                  onShowTag(tag);
                  open = false;
                  resetDrafts();
                }}
              >
                <IconFilter size={15} stroke={2} />
              </studio-icon-button>
              {#if variants.length > 1}
                <studio-icon-button
                  label="Merge {variants.join(', ')} into {tag}"
                  onclick={() => renameEverywhere(tag, [tag], 'Merged casings of')}
                >
                  <IconArrowMerge size={15} stroke={2} />
                </studio-icon-button>
              {/if}
              <studio-icon-button
                label="Rename {tag} everywhere"
                onclick={() => startTagRename(tag)}
              >
                <IconPencil size={15} stroke={2} />
              </studio-icon-button>
              <studio-icon-button
                color="error"
                label="Remove {tag} from every image"
                onclick={() => removeTagEverywhere(tag)}
              >
                <IconX size={15} stroke={2} />
              </studio-icon-button>
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
        <civitai-button size="sm" variant="outline" onclick={undo}>
          <span slot="left"><IconArrowBackUp size={13} stroke={2} /></span>Undo
        </civitai-button>
      </div>
    {/if}
  </div>
</civitai-modal>
