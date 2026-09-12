<script lang="ts">
  import { onMount } from 'svelte';
  import JSZip from 'jszip';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import {
    IconSparkles,
    IconArchive,
    IconRepeat,
    IconUpload,
    IconPhoto,
    IconTag,
    IconFileText,
    IconCheck,
    IconAlertTriangle,
    IconPlus,
    IconMusic,
    IconRefresh,
    IconPencil,
    IconX,
    IconArrowLeft,
    IconArrowRight,
    IconBoltFilled,
  } from '@tabler/icons-svelte';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import * as Tooltip from '@civitai/ui/components/ui/tooltip/index.js';
  import { portalProps } from '$lib/host';
  import {
    ToggleGroup,
    ToggleGroupItem,
  } from '@civitai/ui/components/ui/toggle-group/index.js';
  import { loraTypeById, type LabelType } from '$lib/data/trainingModels';
  import { pool } from '$lib/pool';
  import { runAutoLabel, type AutoLabelResult } from '$lib/autolabel';
  import { isAbort, uploadFile, UploadError } from '$lib/upload';
  import {
    blobAirFromUrl,
    captionTriggerHit,
    defaultStepsFor,
    estimatedTotal,
    isTrainable,
    isTriggerTag,
    labelOptions,
    runCard,
    tagsHaveTrigger,
    type Img,
    type Selection,
  } from './trainingFlow';
  import LabelEditorModal from './LabelEditorModal.svelte';
  import GenerationPickerModal from './GenerationPickerModal.svelte';
  import ReuseDatasetModal from './ReuseDatasetModal.svelte';
  import type { GenerationItem } from '$lib/data/trainingRows';

  // images + trigger are owned by the flow (TrainingFlow) so they survive Back/Continue.
  let {
    selection,
    prices,
    images = $bindable([]),
    trigger = $bindable(''),
    labelMode = $bindable('tag'),
    reuseItems = [],
    onContinue,
    onBack,
  }: {
    selection: Selection;
    /** Live "from" quotes per card type — keeps the running price visible during upload. */
    prices: Record<string, number>;
    images: Img[];
    trigger: string;
    /** The chosen dataset label format — owned by the flow. Fixed to the model's format for single-format
     *  models; user-selectable for a `bothLabels` model (e.g. Anima). */
    labelMode: LabelType;
    /** A "Train again" hand-off: existing blobs (air + caption) to seed the dataset with, no re-upload. */
    reuseItems?: { air: string; caption: string; name: string; previewUrl: string }[];
    onContinue: () => void;
    onBack: () => void;
  } = $props();

  // Seed a reused dataset once on mount (dedup in addFromBlobs makes a Back/Continue remount a no-op).
  onMount(() => {
    if (reuseItems.length)
      addFromBlobs(
        reuseItems.map((r) => ({ blobId: r.air, url: r.previewUrl, name: r.name, caption: r.caption }))
      );
  });

  const type = $derived(loraTypeById(selection.loraType));
  // A dataset has one label type; SelectStep's label-type lock guarantees every run in a multi-run
  // selection shares run[0]'s, so run[0] is representative of the whole dataset.
  const primaryCard = $derived(runCard(selection.runs[0]!));
  const noun = $derived(labelMode === 'tag' ? 'tags' : 'captions');
  const media = $derived(selection.media);
  // The model can train on either format → offer the choice. Single-run only: a multi-run sweep's runs were
  // locked to one format in Select, so mid-flow switching there could desync them.
  const canChooseLabel = $derived(labelOptions(primaryCard).length > 1 && selection.runs.length === 1);

  // Switching format re-labels from scratch — tags and captions aren't interchangeable, so clear every
  // image's label and re-run auto-label in the new mode. (No-op for models that can't switch.)
  function switchLabelMode(next: LabelType) {
    if (next === labelMode) return;
    labelMode = next;
    for (const img of images) {
      img.tags = [];
      img.caption = '';
      img.labelTried = false;
    }
    void ensureLabeling();
  }

  const uploadedCount = $derived(images.filter(isTrainable).length);
  // The dataset-aware estimate — the same figure the Review step shows at its defaults (each run scaled by
  // the image-count-derived step budget, plus samples). Climbs as images upload, so the dataset's effect on
  // price is visible here rather than only at Review. Null (unpriced) hides the badge. `estSteps` surfaces
  // WHY the number moves.
  const estTotal = $derived(estimatedTotal(prices, selection, uploadedCount));
  const estSteps = $derived(defaultStepsFor(selection.loraType, uploadedCount));
  const busy = $derived(images.some((i) => i.status === 'uploading'));
  const blockedCount = $derived(images.filter((i) => i.status === 'blocked').length);
  // A trainable image needs a label — tags or a caption (a global trigger word isn't a per-image label).
  // Auto-labeling fills these for the whole set; an unlabeled dataset must not reach Review.
  const isLabeled = (i: Img) => i.tags.length > 0 || i.caption.trim().length > 0;
  const labeledCount = $derived(images.filter((i) => isTrainable(i) && isLabeled(i)).length);
  const allLabeled = $derived(uploadedCount > 0 && labeledCount === uploadedCount);
  const labelingActive = $derived(images.some((i) => i.labeling));
  // Uploaded images with no label, not already being labeled, and not already auto-label-attempted —
  // what an auto-label run targets. Excluding attempted ones stops the button re-offering a model that
  // returned nothing (a failed step clears the flag, so genuine failures stay retryable).
  const unlabeled = $derived(
    images.filter((i) => isTrainable(i) && !isLabeled(i) && !i.labeling && !i.labelTried && !!i.blobUrl)
  );
  const canContinue = $derived(uploadedCount > 0 && !busy && !labelingActive && allLabeled);
  const enough = $derived(uploadedCount >= type.minImg);

  // Filter the tile grid so a single unlabeled image in a big dataset is findable. Partitions ALL images by
  // whether they carry a label (tags or caption), so a blocked/erroring tile with no label surfaces under
  // "Unlabeled" too — it's a problem tile the user needs to see.
  let filter = $state<'all' | 'labeled' | 'unlabeled'>('all');
  const labeledTotal = $derived(images.filter(isLabeled).length);
  const unlabeledTotal = $derived(images.length - labeledTotal);
  const shownImages = $derived(
    filter === 'labeled'
      ? images.filter(isLabeled)
      : filter === 'unlabeled'
        ? images.filter((i) => !isLabeled(i))
        : images
  );

  let seq = 0;
  let dragging = $state(false);
  let fileInput: HTMLInputElement;
  // In-flight uploads, so removing a tile (or leaving) aborts its request.
  const controllers = new Map<number, AbortController>();

  // Mutate the tile through `images` (the state proxy) rather than the captured ref, so the change
  // is reactive.
  function patch(id: number, values: Partial<Img>) {
    const tile = images.find((x) => x.id === id);
    if (tile) Object.assign(tile, values);
  }

  async function addFiles(list: FileList | null | undefined) {
    if (!list) return;
    const matched = [...list].filter((f) => f.type.startsWith(`${media}/`));
    if (matched.length === 0) return;
    const added: Img[] = matched.map((file) => ({
      id: ++seq,
      file,
      name: file.name,
      previewUrl: URL.createObjectURL(file),
      mediaType: media,
      status: 'uploading',
      progress: 0,
      tags: [],
      caption: '',
    }));
    images = [...images, ...added];
    await pool(added, 4, (img) => uploadOne(img.id, img.file!));
    // Auto-label as soon as this batch's uploads settle. If a run is already going, it drains this batch too.
    void ensureLabeling();
  }

  async function uploadOne(id: number, file: File) {
    const controller = new AbortController();
    controllers.set(id, controller);
    patch(id, { status: 'uploading', progress: 0, message: undefined });
    try {
      const blob = await uploadFile(file, (fraction) => patch(id, { progress: fraction }), controller.signal);
      patch(id, { status: 'uploaded', progress: 1, blobId: blob.id, blobUrl: blob.url ?? undefined });
    } catch (err) {
      if (isAbort(err)) return;
      const permanent = err instanceof UploadError && err.permanent;
      patch(id, {
        status: permanent ? 'blocked' : 'error',
        message: err instanceof Error ? err.message : 'Upload failed',
      });
    } finally {
      controllers.delete(id);
    }
  }

  function retry(id: number) {
    const tile = images.find((x) => x.id === id);
    if (tile?.file) void uploadOne(id, tile.file).then(ensureLabeling);
  }

  // Add items backed by EXISTING orchestrator blobs (a generation or a reused dataset): already uploaded
  // and scanned, so no upload. A `caption` (from a reused dataset) is applied to the right field for the
  // dataset's label type and marks the item labeled; un-captioned items (generations) get auto-labeled.
  function addFromBlobs(items: { blobId: string; url: string; name: string; caption?: string }[]) {
    // Skip blobs already in the dataset — the picker can't see what's here, so re-picking one (or
    // reopening and picking it again) would otherwise add a duplicate tile with the same `air`.
    const have = new Set(images.map((i) => i.blobId).filter(Boolean));
    const fresh = items.filter((item) => !have.has(item.blobId));
    if (fresh.length === 0) return;
    const isTag = labelMode === 'tag';
    const added: Img[] = fresh.map((item) => {
      const label = item.caption?.trim() ?? '';
      return {
        id: ++seq,
        name: item.name,
        previewUrl: item.url,
        mediaType: media,
        status: 'uploaded',
        progress: 1,
        blobId: item.blobId,
        blobUrl: item.url,
        tags: isTag && label ? label.split(',').map((t) => t.trim()).filter(Boolean) : [],
        caption: !isTag ? label : '',
        labelTried: label ? true : undefined,
      };
    });
    images = [...images, ...added];
    void ensureLabeling();
  }

  const MEDIA_EXT: Record<string, Set<string>> = {
    image: new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp']),
    video: new Set(['mp4', 'webm', 'mov', 'mkv']),
    audio: new Set(['mp3', 'wav', 'flac', 'ogg', 'm4a']),
  };
  function mimeFor(ext: string): string {
    return `${media}/${ext === 'jpg' ? 'jpeg' : ext}`;
  }

  // Import a dataset .zip (round-trips with the detail page's Download): each media file becomes an
  // uploaded + scanned tile; a same-named `.txt` supplies its caption (standard LoRA layout). Captioned
  // images are pre-labeled and skip auto-label; un-captioned ones still get it.
  let importing = $state(false);
  let zipInput: HTMLInputElement;
  async function importZip(file: File) {
    if (importing) return;
    importing = true;
    try {
      const zip = await JSZip.loadAsync(file);
      const captions = new Map<string, string>();
      const mediaFiles: { name: string; base: string; ext: string; entry: (typeof zip.files)[string] }[] =
        [];
      for (const entry of Object.values(zip.files)) {
        if (entry.dir) continue;
        const name = entry.name.split('/').pop() ?? entry.name;
        if (name.startsWith('.')) continue; // skip __MACOSX / dotfiles
        const dot = name.lastIndexOf('.');
        const base = dot >= 0 ? name.slice(0, dot) : name;
        const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
        if (ext === 'txt') captions.set(base, (await entry.async('string')).trim());
        else if (MEDIA_EXT[media]?.has(ext)) mediaFiles.push({ name, base, ext, entry });
      }
      const entries = await Promise.all(
        mediaFiles.map(async (m) => ({
          file: new File([await m.entry.async('blob')], m.name, { type: mimeFor(m.ext) }),
          caption: captions.get(m.base) ?? '',
        }))
      );
      await addImported(entries);
    } finally {
      importing = false;
    }
  }

  // Upload zip-imported files, seeding each with its caption (and marking it label-tried so a captioned
  // image isn't re-labeled). Mirrors addFiles, plus the caption seed.
  async function addImported(entries: { file: File; caption: string }[]) {
    if (entries.length === 0) return;
    const isTag = labelMode === 'tag';
    const added: Img[] = entries.map((e) => {
      const label = e.caption.trim();
      return {
        id: ++seq,
        file: e.file,
        name: e.file.name,
        previewUrl: URL.createObjectURL(e.file),
        mediaType: media,
        status: 'uploading' as const,
        progress: 0,
        tags: isTag && label ? label.split(',').map((t) => t.trim()).filter(Boolean) : [],
        caption: !isTag ? label : '',
        labelTried: label ? true : undefined,
      };
    });
    images = [...images, ...added];
    await pool(added, 4, (img) => uploadOne(img.id, img.file!));
    void ensureLabeling();
  }
  function onPickZip(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (file) void importZip(file);
    input.value = '';
  }

  function remove(id: number) {
    controllers.get(id)?.abort();
    controllers.delete(id);
    const tile = images.find((x) => x.id === id);
    if (tile) URL.revokeObjectURL(tile.previewUrl);
    images = images.filter((x) => x.id !== id);
  }

  // Free auto-labeling, automatic: it kicks off as soon as an upload batch settles (and after a retry),
  // tag models get WD tags, caption models get a caption. A single drain loop labels every uploaded image
  // once — images that finish uploading while a run is in flight are picked up on the next pass, so a
  // second `ensureLabeling()` call during a run is a no-op. `labelRun` tracks the current pass for the
  // progress counter (labeledCount is whole-set, so it can't stand in here).
  let labelController: AbortController | null = null;
  let labelRun = $state<{ total: number; done: number; keys: Set<string> } | null>(null);

  async function ensureLabeling() {
    if (labelController) return; // a drain loop is already running; it will pick up new uploads
    const controller = new AbortController();
    labelController = controller;
    try {
      while (unlabeled.length > 0) {
        const targets = unlabeled;
        const items = targets.map((t) => ({ key: String(t.id), mediaUrl: t.blobUrl! }));
        labelRun = { total: targets.length, done: 0, keys: new Set(items.map((i) => i.key)) };
        for (const t of targets) patch(t.id, { labeling: true });
        await runAutoLabel(labelMode, media, items, applyLabel, controller.signal);
      }
    } catch (err) {
      if (!isAbort(err)) for (const i of images) if (i.labeling) patch(i.id, { labeling: false });
    } finally {
      labelController = null;
      labelRun = null;
    }
  }

  function applyLabel(r: AutoLabelResult) {
    const img = images.find((x) => String(x.id) === r.key);
    if (!img) return;
    img.labeling = false;
    img.labelTried = true; // attempted (any outcome) — the drain labels each image once; failures go manual
    if (labelRun?.keys.has(r.key)) labelRun.done += 1; // count only this pass's own targets
    if (r.status === 'failed') return;
    if (r.tags?.length) img.tags = [...new Set(r.tags)]; // chips are keyed on the tag string — keep unique
    if (r.caption) img.caption = r.caption;
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    dragging = false;
    void addFiles(e.dataTransfer?.files);
  }
  function onPick(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    void addFiles(input.files);
    input.value = ''; // let the same file be re-picked after a remove
  }

  let genPickerOpen = $state(false);
  let reuseOpen = $state(false);
  function addFromGenerations(items: GenerationItem[]) {
    addFromBlobs(
      items.map((i) => ({
        // The AIR (what trains) comes from the FULL blob url; the tile preview + auto-label use the small
        // preview so importing doesn't pull every full-size image into the browser.
        blobId: blobAirFromUrl(i.url),
        url: i.previewUrl ?? i.url,
        name: `generation ${i.blobId.slice(0, 8)}`,
      }))
    );
  }

  // ---- label editor: opens LabelEditorModal for one uploaded image ----
  let editorOpen = $state(false);
  let editorId = $state(0);
  const editing = $derived(images.find((x) => x.id === editorId));

  function openEditor(id: number) {
    editorId = id;
    editorOpen = true;
  }

  // This dataset's tags, frequency-ranked — feeds the editor's autocomplete.
  const tagVocab = $derived.by(() => {
    const freq = new Map<string, number>();
    for (const img of images) for (const t of img.tags) freq.set(t, (freq.get(t) ?? 0) + 1);
    return [...freq.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t);
  });

  // Re-run auto-label for one image (the editor's Re-run) — clears its label first so an already-attempted
  // image (labelTried) gets a fresh pass.
  async function relabelOne(id: number) {
    const img = images.find((x) => x.id === id);
    if (!img || !img.blobUrl || img.labeling) return;
    patch(id, { labeling: true, labelTried: false, tags: [], caption: '' });
    try {
      const item = [{ key: String(id), mediaUrl: img.blobUrl }];
      await runAutoLabel(labelMode, media, item, applyLabel, new AbortController().signal);
    } catch (err) {
      if (!isAbort(err)) patch(id, { labeling: false });
    }
  }

  // For the tile previews' prepended trigger chip; the display rules live in trainingFlow.
  const triggerText = $derived(trigger.trim());
</script>

{#snippet triggerTags(tags: string[], limit: number)}
  <div class="flex flex-wrap gap-1">
    {#if triggerText && !tagsHaveTrigger(trigger, tags)}
      <span class="rounded border border-buzz/30 bg-buzz/10 px-1.5 py-0.5 font-mono text-xs text-buzz">
        {triggerText}
      </span>
    {/if}
    {#each tags.slice(0, limit) as t (t)}
      <span
        class="rounded border px-1.5 py-0.5 font-mono text-xs {isTriggerTag(trigger, t)
          ? 'border-buzz/30 bg-buzz/10 text-buzz'
          : 'border-dark-4 bg-dark-7 text-dark-2'}"
      >
        {t}
      </span>
    {/each}
    {#if tags.length > limit}
      {@const triggerHidden =
        triggerText &&
        tagsHaveTrigger(trigger, tags) &&
        !tags.slice(0, limit).some((t) => isTriggerTag(trigger, t))}
      <span
        class="rounded px-1.5 py-0.5 font-mono text-xs {triggerHidden
          ? 'border border-buzz/30 bg-buzz/10 text-buzz'
          : 'text-dark-2'}"
        title={triggerHidden ? `includes the trigger word "${triggerText}"` : undefined}
      >
        +{tags.length - limit}
      </span>
    {/if}
  </div>
{/snippet}

{#snippet triggerCaption(caption: string)}
  {@const hit = captionTriggerHit(trigger, caption)}
  <div class="line-clamp-3 text-xs leading-snug text-dark-2">
    {#if hit}{hit.before}<span class="font-semibold text-buzz">{hit.match}</span>{hit.after}{:else}{#if triggerText}<span
          class="font-semibold text-buzz">{triggerText}</span
        >, {/if}{caption}{/if}
  </div>
{/snippet}

<div class="flex flex-col gap-5">
  <div class="flex flex-wrap items-start justify-between gap-4">
    <div class="min-w-0">
      <h2 class="m-0 text-xl font-semibold text-white">Add your data</h2>
      <p class="mt-1 text-sm text-dark-2">
        Drop your files — they upload and get scanned as you go. We'll auto-label them as
        <strong class="text-dark-0">{noun}</strong> for free.
      </p>
    </div>
    {#if estTotal != null}
      <div class="shrink-0 rounded-xl border border-dark-4 bg-dark-6 px-4 py-2 text-right">
        <div class="font-mono text-xs uppercase tracking-wider text-dark-2">Estimated price</div>
        <div class="font-mono text-lg font-bold leading-tight text-buzz">
          <IconBoltFilled size={15} stroke={2} class="mb-0.5 inline" />{estTotal.toLocaleString()}
        </div>
        <div class="mt-0.5 font-mono text-xs text-dark-2">
          {uploadedCount} image{uploadedCount === 1 ? '' : 's'} · ~{estSteps.toLocaleString()} steps · adjust
          at Review
        </div>
      </div>
    {/if}
  </div>

  <div class="flex flex-wrap gap-2.5">
    <Button variant="outline" onclick={() => fileInput.click()}>
      <IconUpload size={15} stroke={2} class="mr-1.5 inline" />Upload files
    </Button>
    <Button variant="outline" onclick={() => (genPickerOpen = true)}>
      <IconPhoto size={15} stroke={2} class="mr-1.5 inline" />From my generations
    </Button>
    <Button variant="outline" onclick={() => zipInput.click()} disabled={importing}>
      <IconArchive size={15} stroke={2} class="mr-1.5 inline" />{importing ? 'Importing…' : 'Import .zip'}
    </Button>
    <Button variant="outline" onclick={() => (reuseOpen = true)}>
      <IconRepeat size={15} stroke={2} class="mr-1.5 inline" />Reuse a dataset
    </Button>
  </div>

  <input
    bind:this={fileInput}
    type="file"
    multiple
    accept={`${media}/*`}
    class="hidden"
    onchange={onPick}
  />
  <input
    bind:this={zipInput}
    type="file"
    accept=".zip,application/zip"
    class="hidden"
    onchange={onPickZip}
  />

  {#if images.length === 0}
    <button
      type="button"
      onclick={() => fileInput.click()}
      ondragover={(e) => {
        e.preventDefault();
        dragging = true;
      }}
      ondragleave={() => (dragging = false)}
      ondrop={onDrop}
      class="rounded-xl border-2 border-dashed p-9 text-center transition
        {dragging ? 'border-primary bg-primary/[0.06]' : 'border-dark-4 bg-dark-6 hover:border-primary'}"
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.75"
        stroke-linecap="round"
        stroke-linejoin="round"
        class="mx-auto h-8 w-8 text-dark-2"
        aria-hidden="true"
      >
        <path d="M12 13v8" />
        <path d="m8 17 4-4 4 4" />
        <path
          d="M20 16.7A5 5 0 0 0 18 7h-1.26A8 8 0 1 0 4 15.25"
        />
      </svg>
      <div class="mt-2 text-base font-semibold text-dark-0">
        Drop your {media} files here, or click to browse
      </div>
      <div class="mt-2 font-mono text-xs text-dark-2">Uploaded one by one · scanned on upload</div>
    </button>
  {:else}
    <div class="grid gap-5 lg:grid-cols-[minmax(0,1fr)_280px]">
      <div class="min-w-0">
        <div class="mb-4 flex items-center gap-3 rounded-xl border border-dark-4 bg-dark-6 px-4 py-3">
          <span class="grid h-8 w-8 shrink-0 place-items-center rounded bg-primary/15 text-primary">
            {#if labelMode === 'tag'}<IconTag size={16} stroke={2} />{:else}<IconFileText
                size={16}
                stroke={2}
              />{/if}
          </span>
          <div class="min-w-0">
            <div class="text-sm font-bold text-dark-0">Auto-labeled as {noun} · free</div>
            <div class="font-mono text-xs text-dark-2">
              {labelMode === 'tag'
                ? `${primaryCard.name} trains on booru-style tags`
                : `${primaryCard.name} learns from natural-language captions`}{canChooseLabel
                ? ' — switch the format below'
                : ' — chosen automatically'}
            </div>
          </div>
          {#if canChooseLabel}
            <div class="ml-auto shrink-0">
              <ToggleGroup
                type="single"
                value={labelMode}
                onValueChange={(v) => {
                  if (v === 'tag' || v === 'caption') switchLabelMode(v);
                }}
                variant="outline"
                size="sm"
              >
                <ToggleGroupItem value="tag" aria-label="Label with tags" disabled={labelingActive}>
                  Tags
                </ToggleGroupItem>
                <ToggleGroupItem
                  value="caption"
                  aria-label="Label with captions"
                  disabled={labelingActive}
                >
                  Captions
                </ToggleGroupItem>
              </ToggleGroup>
            </div>
          {/if}
        </div>

        <div
          class="mb-4 flex items-center gap-2 rounded-md border px-4 py-2.5 text-sm
            {enough
            ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-400'
            : 'border-buzz/30 bg-buzz/10 text-buzz'}"
        >
          {#if enough}
            <IconCheck size={15} stroke={2} class="mr-1 inline shrink-0" />{uploadedCount} uploaded — good
            for a {type.name.toLowerCase()} (we recommend ≥{type.minImg}).
          {:else}
            <IconAlertTriangle size={15} stroke={2} class="mr-1 inline shrink-0" />{uploadedCount} uploaded.
            We recommend at least {type.minImg} for a {type.name.toLowerCase()} — add more.
          {/if}
        </div>

        <div class="mb-3 flex items-center justify-between">
          <b class="text-dark-0">
            {images.length}
            {images.length === 1 ? 'file' : 'files'}
            {#if busy}· uploading…{/if}
            {#if uploadedCount > 0}·
              <span class={labeledCount === uploadedCount ? 'text-emerald-400' : 'text-dark-2'}>
                {labeledCount}/{uploadedCount} labeled
              </span>{/if}
            {#if blockedCount > 0}· <span class="text-red-400">{blockedCount} blocked</span>{/if}
          </b>
          <div class="flex items-center gap-2">
            {#if unlabeled.length > 0 || labelRun}
              <Button size="xs" onclick={ensureLabeling} disabled={labelRun != null || unlabeled.length === 0}>
                <IconSparkles size={13} stroke={2} class="mr-1 inline" />{#if labelRun}Labeling… {labelRun.done}/{labelRun.total}{:else}Auto-label {unlabeled.length}{/if}
              </Button>
            {/if}
            <Button variant="outline" size="xs" onclick={() => fileInput.click()}>
              <IconPlus size={13} stroke={2} class="mr-1 inline" />Add more
            </Button>
          </div>
        </div>

        <div class="mb-3">
          <ToggleGroup
            type="single"
            value={filter}
            onValueChange={(v) => {
              if (v === 'all' || v === 'labeled' || v === 'unlabeled') filter = v;
            }}
            variant="outline"
            size="sm"
            class="self-start"
          >
            <ToggleGroupItem value="all" aria-label="Show all images">All {images.length}</ToggleGroupItem>
            <ToggleGroupItem value="labeled" aria-label="Show labeled images">
              Labeled {labeledTotal}
            </ToggleGroupItem>
            <ToggleGroupItem value="unlabeled" aria-label="Show unlabeled images">
              Unlabeled <span class={unlabeledTotal > 0 ? 'ml-1 font-semibold text-dark-0' : 'ml-1'}
                >{unlabeledTotal}</span
              >
            </ToggleGroupItem>
          </ToggleGroup>
        </div>

        {#if shownImages.length === 0}
          <div
            class="rounded-xl border border-dashed border-dark-4 bg-dark-6 p-8 text-center font-mono text-xs text-dark-2"
          >
            {filter === 'unlabeled'
              ? 'No unlabeled images — every image has a label.'
              : filter === 'labeled'
                ? 'No labeled images yet.'
                : 'No images.'}
          </div>
        {/if}

        <div class="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-3">
          {#each shownImages as img (img.id)}
            <div class="overflow-hidden rounded-md border border-dark-4 bg-dark-6">
              <div class="relative aspect-square bg-dark-7">
                {#if img.mediaType === 'image'}
                  <img src={img.previewUrl} alt={img.name} class="h-full w-full object-cover" />
                {:else if img.mediaType === 'video'}
                  <!-- svelte-ignore a11y_media_has_caption -->
                  <video src={img.previewUrl} muted class="h-full w-full object-cover"></video>
                {:else}
                  <div class="flex h-full flex-col items-center justify-center gap-2 p-2.5 text-center">
                    <IconMusic size={20} stroke={2} class="text-dark-2" />
                    <span class="line-clamp-2 break-all font-mono text-xs leading-tight text-dark-2">
                      {img.name}
                    </span>
                    <audio src={img.previewUrl} controls preload="metadata" class="h-8 w-full"></audio>
                  </div>
                {/if}

                {#if img.status === 'uploading'}
                  <div class="absolute inset-0 grid place-items-center bg-black/50">
                    <span class="flex items-center gap-1 font-mono text-xs text-white">
                      <IconUpload size={12} stroke={2} />{Math.round(img.progress * 100)}%
                    </span>
                  </div>
                  <div class="absolute bottom-0 left-0 h-1 bg-primary transition-[width]" style:width="{img.progress * 100}%"></div>
                {:else if img.status === 'blocked'}
                  <div class="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-red-950/70 p-2 text-center">
                    <IconAlertTriangle size={18} stroke={2} class="text-red-200" />
                    <span class="font-mono text-xs leading-tight text-red-200">{img.message}</span>
                  </div>
                {:else if img.status === 'error'}
                  <div class="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-black/70 p-2 text-center">
                    <span class="font-mono text-xs leading-tight text-buzz">{img.message}</span>
                    <Button variant="outline" size="xs" onclick={() => retry(img.id)}>
                      <IconRefresh size={12} stroke={2} class="mr-1 inline" />Retry
                    </Button>
                  </div>
                {/if}

                <div class="absolute right-1.5 top-1.5 flex gap-1">
                  {#if img.status === 'uploaded'}
                    <button
                      type="button"
                      aria-label="Edit label"
                      onclick={() => openEditor(img.id)}
                      class="grid h-6 w-6 place-items-center rounded-md bg-black/60 text-on-accent hover:bg-primary"
                    >
                      <IconPencil size={13} stroke={2} />
                    </button>
                  {/if}
                  <button
                    type="button"
                    aria-label="Remove"
                    onclick={() => remove(img.id)}
                    class="grid h-6 w-6 place-items-center rounded-md bg-black/60 text-on-accent hover:bg-red-500"
                  >
                    <IconX size={13} stroke={2} />
                  </button>
                </div>

                {#if img.status === 'uploaded'}
                  <span class="absolute left-1.5 top-1.5 grid h-5 w-5 place-items-center rounded-full bg-emerald-500 text-on-accent">
                    <IconCheck size={12} stroke={3} />
                  </span>
                {/if}
              </div>

              <div class="min-h-[44px] p-2.5">
                {#if img.status !== 'uploaded'}
                  <div class="font-mono text-xs text-dark-2">
                    {img.status === 'uploading' ? 'uploading…' : img.status === 'blocked' ? 'blocked' : 'failed'}
                  </div>
                {:else if img.labeling}
                  <div class="flex items-center justify-center gap-1 font-mono text-xs text-primary">
                    <IconSparkles size={12} stroke={2} /> labeling…
                  </div>
                {:else if img.tags.length === 0 && !img.caption}
                  <button
                    type="button"
                    onclick={() => openEditor(img.id)}
                    class="inline-flex items-center gap-1 font-mono text-xs text-dark-2 hover:text-primary"
                  >
                    <IconPlus size={12} stroke={2} />add label
                  </button>
                {:else if labelMode === 'tag'}
                  {@render triggerTags(img.tags, 4)}
                {:else}
                  {@render triggerCaption(img.caption)}
                {/if}
              </div>
            </div>
          {/each}
        </div>
      </div>

      <aside class="sticky top-4 h-fit max-h-[calc(100dvh-2rem)] overflow-y-auto rounded-xl border border-dark-4 bg-dark-6 p-5">
        <div class="flex items-center gap-1.5">
          <h3 class="m-0 font-mono text-xs uppercase tracking-widest text-dark-2">Trigger word</h3>
          <Tooltip.Provider>
            <Tooltip.Root>
              <Tooltip.Trigger
                class="grid h-4 w-4 place-items-center rounded-full border border-dark-4 font-mono text-xs text-dark-2"
              >
                ?
              </Tooltip.Trigger>
              <Tooltip.Content class="max-w-[240px] text-xs" portalProps={portalProps()}>
                An optional word prepended to every label. The model learns to associate it with your
                subject, so you type it in prompts to summon the LoRA. Less essential on modern caption
                models; handy for characters. Some large/video models can't train it (no-op).
              </Tooltip.Content>
            </Tooltip.Root>
          </Tooltip.Provider>
        </div>
        <Input bind:value={trigger} placeholder="optional, e.g. my_character" class="mt-2 font-mono" />
        <p class="mt-2 text-[12px] leading-snug text-dark-2">
          Prepended to each label when missing, and <span class="text-buzz">highlighted</span> where
          it already appears. Leave blank to skip.
        </p>
      </aside>
    </div>
  {/if}

  <div class="flex items-center justify-between gap-3 border-t border-dark-4 pt-5">
    <Button variant="outline" onclick={onBack}>
      <IconArrowLeft size={15} stroke={2} class="mr-1.5 inline" />Back
    </Button>
    <div class="flex items-center gap-3">
      {#if uploadedCount > 0 && !busy && !allLabeled}
        <button
          id="continue-blocked-reason"
          type="button"
          onclick={() => (filter = 'unlabeled')}
          class="font-mono text-xs text-buzz underline decoration-dotted underline-offset-2 transition-colors hover:text-buzz/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          {uploadedCount - labeledCount} unlabeled — show {uploadedCount - labeledCount === 1
            ? 'it'
            : 'them'}
        </button>
      {/if}
      <Button
        disabled={!canContinue}
        onclick={onContinue}
        title={!canContinue && uploadedCount > 0 && !allLabeled
          ? 'Label every image to continue'
          : undefined}
        aria-describedby={!canContinue && uploadedCount > 0 && !allLabeled
          ? 'continue-blocked-reason'
          : undefined}
      >
        Continue to review<IconArrowRight size={15} stroke={2} class="ml-1.5 inline" />
      </Button>
    </div>
  </div>
</div>

<LabelEditorModal
  bind:open={editorOpen}
  {editing}
  {labelMode}
  {trigger}
  {tagVocab}
  onRelabel={relabelOne}
/>

<GenerationPickerModal bind:open={genPickerOpen} {media} onAdd={addFromGenerations} />
<ReuseDatasetModal bind:open={reuseOpen} {media} onReuse={addFromBlobs} />
