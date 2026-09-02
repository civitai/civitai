<script lang="ts">
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import { Textarea } from '@civitai/ui/components/ui/textarea/index.js';
  import * as Dialog from '@civitai/ui/components/ui/dialog/index.js';
  import * as Tooltip from '@civitai/ui/components/ui/tooltip/index.js';
  import { loraTypeById } from '$lib/data/trainingModels';
  import { pool } from '$lib/pool';
  import { isAbort, uploadFile, UploadError } from '$lib/upload';
  import { isTrainable, labelNoun, runCard, type Img, type Selection } from './trainingFlow';

  // images + trigger are owned by the flow (TrainingFlow) so they survive Back/Continue.
  let {
    selection,
    images = $bindable([]),
    trigger = $bindable(''),
    onContinue,
    onBack,
  }: {
    selection: Selection;
    images: Img[];
    trigger: string;
    onContinue: () => void;
    onBack: () => void;
  } = $props();

  const type = $derived(loraTypeById(selection.loraType));
  // A dataset has one label type; SelectStep's label-type lock guarantees every run in a multi-run
  // selection shares run[0]'s, so run[0] is representative of the whole dataset.
  const primaryCard = $derived(runCard(selection.runs[0]!));
  const labelMode = $derived(primaryCard.label);
  const noun = $derived(labelNoun(primaryCard));
  const media = $derived(selection.media);

  const uploadedCount = $derived(images.filter(isTrainable).length);
  const busy = $derived(images.some((i) => i.status === 'uploading'));
  const blockedCount = $derived(images.filter((i) => i.status === 'blocked').length);
  // A trainable image needs a label — tags or a caption (a global trigger word isn't a per-image label).
  // Auto-labeling (next slice) fills these for the whole set; until then it's manual, but an unlabeled
  // dataset must not reach Review.
  const labeledCount = $derived(
    images.filter((i) => isTrainable(i) && (i.tags.length > 0 || i.caption.trim().length > 0)).length
  );
  const allLabeled = $derived(uploadedCount > 0 && labeledCount === uploadedCount);
  const canContinue = $derived(uploadedCount > 0 && !busy && allLabeled);
  const enough = $derived(uploadedCount >= type.minImg);

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
      previewUrl: URL.createObjectURL(file),
      mediaType: media,
      status: 'uploading',
      progress: 0,
      tags: [],
      caption: '',
    }));
    images = [...images, ...added];
    await pool(added, 4, (img) => uploadOne(img.id, img.file));
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
    if (tile) void uploadOne(id, tile.file);
  }

  function remove(id: number) {
    controllers.get(id)?.abort();
    controllers.delete(id);
    const tile = images.find((x) => x.id === id);
    if (tile) URL.revokeObjectURL(tile.previewUrl);
    images = images.filter((x) => x.id !== id);
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

  // ---- label editor (manual for now; auto-label is the next slice) ----
  let editorOpen = $state(false);
  let editorId = $state(0);
  let newTag = $state('');
  const editing = $derived(images.find((x) => x.id === editorId));

  function openEditor(id: number) {
    editorId = id;
    newTag = '';
    editorOpen = true;
  }
  function addTag() {
    const value = newTag.trim();
    if (editing && value && !editing.tags.includes(value)) {
      editing.tags = [...editing.tags, value];
    }
    newTag = '';
  }
  function removeTag(tag: string) {
    if (editing) editing.tags = editing.tags.filter((t) => t !== tag);
  }

  // The trigger word is only prepended to a label that doesn't already contain it; where it's already
  // present it's highlighted in place rather than duplicated. Matching is case-insensitive.
  const triggerText = $derived(trigger.trim());
  const isTriggerTag = (tag: string) =>
    triggerText.length > 0 && tag.toLowerCase() === triggerText.toLowerCase();
  const tagsHaveTrigger = (tags: string[]) => tags.some(isTriggerTag);
  function captionHit(caption: string) {
    if (!triggerText) return null;
    const idx = caption.toLowerCase().indexOf(triggerText.toLowerCase());
    if (idx < 0) return null;
    return {
      before: caption.slice(0, idx),
      match: caption.slice(idx, idx + triggerText.length),
      after: caption.slice(idx + triggerText.length),
    };
  }
</script>

{#snippet triggerTags(tags: string[], limit: number)}
  <div class="flex flex-wrap gap-1">
    {#if triggerText && !tagsHaveTrigger(tags)}
      <span class="rounded border border-[#f59f00]/30 bg-[#f59f00]/10 px-1.5 py-0.5 font-mono text-[10px] text-[#f59f00]">
        {triggerText}
      </span>
    {/if}
    {#each tags.slice(0, limit) as t (t)}
      <span
        class="rounded border px-1.5 py-0.5 font-mono text-[10px] {isTriggerTag(t)
          ? 'border-[#f59f00]/30 bg-[#f59f00]/10 text-[#f59f00]'
          : 'border-dark-4 bg-dark-7 text-dark-2'}"
      >
        {t}
      </span>
    {/each}
    {#if tags.length > limit}
      <span class="rounded px-1.5 py-0.5 font-mono text-[10px] text-dark-2">+{tags.length - limit}</span>
    {/if}
  </div>
{/snippet}

{#snippet triggerCaption(caption: string)}
  {@const hit = captionHit(caption)}
  <div class="line-clamp-3 text-[11px] leading-snug text-dark-2">
    {#if hit}{hit.before}<span class="font-semibold text-[#f59f00]">{hit.match}</span>{hit.after}{:else}{#if triggerText}<span
          class="font-semibold text-[#f59f00]">{triggerText}</span
        >, {/if}{caption}{/if}
  </div>
{/snippet}

<div class="flex flex-col gap-5">
  <div>
    <h2 class="m-0 text-xl font-semibold text-white">Add your data</h2>
    <p class="mt-1 text-sm text-dark-2">
      Drop your files — they upload and get scanned as you go. We'll auto-label them as
      <strong class="text-dark-0">{noun}</strong> for free.
    </p>
  </div>

  <div class="flex flex-wrap gap-2.5">
    <Button variant="outline" onclick={() => fileInput.click()}>⬆ Upload files</Button>
    <Button variant="outline" disabled title="Coming soon">🖼 From my generations</Button>
    <Button variant="outline" disabled title="Coming soon">♻ Reuse a dataset</Button>
  </div>

  <input
    bind:this={fileInput}
    type="file"
    multiple
    accept={`${media}/*`}
    class="hidden"
    onchange={onPick}
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
      class="rounded-md border-2 border-dashed p-9 text-center transition
        {dragging ? 'border-primary bg-primary/[0.06]' : 'border-dark-4 bg-dark-6 hover:border-primary'}"
    >
      <div class="text-3xl">📁</div>
      <div class="mt-2 text-base font-semibold text-dark-0">
        Drop your {media} files here, or click to browse
      </div>
      <div class="mt-2 font-mono text-xs text-dark-2">Uploaded one by one · scanned on upload</div>
    </button>
  {:else}
    <div class="grid gap-5 lg:grid-cols-[minmax(0,1fr)_280px]">
      <div class="min-w-0">
        <div class="mb-4 flex items-center gap-3 rounded-md border border-dark-4 bg-dark-6 px-4 py-3">
          <span class="grid h-8 w-8 place-items-center rounded bg-primary/15 text-base">
            {labelMode === 'tag' ? '🏷️' : '📝'}
          </span>
          <div>
            <div class="text-sm font-bold text-dark-0">Will be auto-labeled as {noun} · free</div>
            <div class="font-mono text-[11px] text-dark-2">
              {labelMode === 'tag'
                ? `${primaryCard.name} trains on booru-style tags`
                : `${primaryCard.name} learns from natural-language captions`} — chosen automatically
            </div>
          </div>
        </div>

        <div
          class="mb-4 flex items-center gap-2 rounded-md border px-4 py-2.5 text-sm
            {enough
            ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-400'
            : 'border-[#f59f00]/30 bg-[#f59f00]/10 text-[#f59f00]'}"
        >
          {#if enough}
            ✓ {uploadedCount} uploaded — good for a {type.name.toLowerCase()} (we recommend ≥{type.minImg}).
          {:else}
            ⚠️ {uploadedCount} uploaded. We recommend at least {type.minImg} for a
            {type.name.toLowerCase()} — add more.
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
          <Button variant="outline" size="xs" onclick={() => fileInput.click()}>＋ Add more</Button>
        </div>

        <div class="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-3">
          {#each images as img (img.id)}
            <div class="overflow-hidden rounded-md border border-dark-4 bg-dark-6">
              <div class="relative aspect-square bg-dark-7">
                {#if img.mediaType === 'image'}
                  <img src={img.previewUrl} alt="" class="h-full w-full object-cover" />
                {:else if img.mediaType === 'video'}
                  <!-- svelte-ignore a11y_media_has_caption -->
                  <video src={img.previewUrl} muted class="h-full w-full object-cover"></video>
                {:else}
                  <div class="flex h-full flex-col items-center justify-center gap-1 p-2 text-center">
                    <span class="text-2xl">🎵</span>
                    <span class="line-clamp-2 break-all font-mono text-[10px] text-dark-2">{img.file.name}</span>
                  </div>
                {/if}

                {#if img.status === 'uploading'}
                  <div class="absolute inset-0 grid place-items-center bg-black/50">
                    <span class="font-mono text-[11px] text-white">⬆ {Math.round(img.progress * 100)}%</span>
                  </div>
                  <div class="absolute bottom-0 left-0 h-1 bg-primary transition-[width]" style:width="{img.progress * 100}%"></div>
                {:else if img.status === 'blocked'}
                  <div class="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-red-950/70 p-2 text-center">
                    <span class="text-lg">⚠️</span>
                    <span class="font-mono text-[10px] leading-tight text-red-200">{img.message}</span>
                  </div>
                {:else if img.status === 'error'}
                  <div class="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-black/70 p-2 text-center">
                    <span class="font-mono text-[10px] leading-tight text-[#f59f00]">{img.message}</span>
                    <Button variant="outline" size="xs" onclick={() => retry(img.id)}>↻ Retry</Button>
                  </div>
                {/if}

                <div class="absolute right-1.5 top-1.5 flex gap-1">
                  {#if img.status === 'uploaded'}
                    <button
                      type="button"
                      aria-label="Edit label"
                      onclick={() => openEditor(img.id)}
                      class="grid h-6 w-6 place-items-center rounded-md bg-black/60 text-xs text-white hover:bg-primary"
                    >
                      ✎
                    </button>
                  {/if}
                  <button
                    type="button"
                    aria-label="Remove"
                    onclick={() => remove(img.id)}
                    class="grid h-6 w-6 place-items-center rounded-md bg-black/60 text-xs text-white hover:bg-red-500"
                  >
                    ✕
                  </button>
                </div>

                {#if img.status === 'uploaded'}
                  <span class="absolute left-1.5 top-1.5 grid h-5 w-5 place-items-center rounded-full bg-emerald-500 text-[10px] font-bold text-white">
                    ✓
                  </span>
                {/if}
              </div>

              <div class="min-h-[44px] p-2.5">
                {#if img.status !== 'uploaded'}
                  <div class="font-mono text-[11px] text-dark-2">
                    {img.status === 'uploading' ? 'uploading…' : img.status === 'blocked' ? 'blocked' : 'failed'}
                  </div>
                {:else if img.tags.length === 0 && !img.caption}
                  <button
                    type="button"
                    onclick={() => openEditor(img.id)}
                    class="font-mono text-[11px] text-dark-2 hover:text-primary"
                  >
                    ＋ add label
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

      <aside class="sticky top-4 h-fit max-h-[calc(100dvh-2rem)] overflow-y-auto rounded-md border border-dark-4 bg-dark-6 p-5">
        <div class="flex items-center gap-1.5">
          <h3 class="m-0 font-mono text-xs uppercase tracking-widest text-dark-2">Trigger word</h3>
          <Tooltip.Provider>
            <Tooltip.Root>
              <Tooltip.Trigger
                class="grid h-4 w-4 place-items-center rounded-full border border-dark-4 font-mono text-[10px] text-dark-2"
              >
                ?
              </Tooltip.Trigger>
              <Tooltip.Content class="max-w-[240px] text-xs">
                An optional word prepended to every label. The model learns to associate it with your
                subject, so you type it in prompts to summon the LoRA. Less essential on modern caption
                models; handy for characters. Some large/video models can't train it (no-op).
              </Tooltip.Content>
            </Tooltip.Root>
          </Tooltip.Provider>
        </div>
        <Input bind:value={trigger} placeholder="optional, e.g. my_character" class="mt-2 font-mono" />
        <p class="mt-2 text-[12px] leading-snug text-dark-2">
          Prepended to each label when missing, and <span class="text-[#f59f00]">highlighted</span> where
          it already appears. Leave blank to skip.
        </p>
      </aside>
    </div>
  {/if}

  <div class="flex items-center justify-between gap-3 border-t border-dark-4 pt-5">
    <Button variant="outline" onclick={onBack}>← Back</Button>
    <div class="flex items-center gap-3">
      {#if uploadedCount > 0 && !busy && !allLabeled}
        <span class="font-mono text-xs text-[#f59f00]">
          {uploadedCount - labeledCount} unlabeled — label every image to continue
        </span>
      {/if}
      <Button disabled={!canContinue} onclick={onContinue}>Continue to Review →</Button>
    </div>
  </div>
</div>

<!-- label editor -->
<Dialog.Root bind:open={editorOpen}>
  <Dialog.Content class="max-w-3xl">
    {#if editing}
      <Dialog.Header>
        <Dialog.Title>{labelMode === 'tag' ? 'Edit tags' : 'Edit caption'}</Dialog.Title>
        <Dialog.Description>{editing.file.name}</Dialog.Description>
      </Dialog.Header>

      {#if labelMode === 'tag'}
        <div class="grid gap-4 sm:grid-cols-[220px_1fr]">
          <img src={editing.previewUrl} alt="" class="w-full rounded border border-dark-4 object-cover" />
          <div>
            <div class="mb-2 font-mono text-xs uppercase tracking-wider text-dark-2">
              Tags {#if triggerText}·
                <span class="text-[#f59f00]">{triggerText}</span>
                {tagsHaveTrigger(editing.tags) ? 'highlighted' : 'prepended'}{/if}
            </div>
            <div class="flex min-h-[64px] flex-wrap content-start gap-1.5 rounded border border-dark-4 bg-dark-7 p-2.5">
              {#if triggerText && !tagsHaveTrigger(editing.tags)}
                <span class="rounded border border-[#f59f00]/30 bg-[#f59f00]/10 px-2 py-1 font-mono text-xs text-[#f59f00]">
                  {triggerText}
                </span>
              {/if}
              {#each editing.tags as t (t)}
                <span
                  class="inline-flex items-center gap-1.5 rounded border px-2 py-1 font-mono text-xs {isTriggerTag(t)
                    ? 'border-[#f59f00]/30 bg-[#f59f00]/10 text-[#f59f00]'
                    : 'border-dark-4 bg-dark-6 text-dark-0'}"
                >
                  {t}
                  <button type="button" aria-label={`Remove ${t}`} onclick={() => removeTag(t)} class="text-dark-2 hover:text-red-400">✕</button>
                </span>
              {/each}
            </div>
            <form
              class="mt-2 flex gap-2"
              onsubmit={(e) => {
                e.preventDefault();
                addTag();
              }}
            >
              <Input bind:value={newTag} placeholder="Add a tag and press Enter" class="font-mono" />
              <Button type="submit" variant="outline">Add</Button>
            </form>
          </div>
        </div>
      {:else}
        <div class="flex flex-col gap-3">
          <img src={editing.previewUrl} alt="" class="h-44 w-full rounded border border-dark-4 object-contain" />
          <div>
            <div class="mb-2 font-mono text-xs uppercase tracking-wider text-dark-2">Caption</div>
            <Textarea bind:value={editing.caption} rows={6} />
            <p class="mt-2 text-xs text-dark-2">
              {#if !triggerText}
                No trigger word set.
              {:else if captionHit(editing.caption)}
                Trigger <span class="text-[#f59f00]">{triggerText}</span> is highlighted where it appears.
              {:else}
                Trigger <span class="text-[#f59f00]">{triggerText}</span> is prepended automatically.
              {/if}
            </p>
          </div>
        </div>
      {/if}

      <Dialog.Footer>
        <Button onclick={() => (editorOpen = false)}>Done</Button>
      </Dialog.Footer>
    {/if}
  </Dialog.Content>
</Dialog.Root>
