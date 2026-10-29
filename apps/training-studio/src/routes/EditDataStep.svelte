<script lang="ts">
  import { SvelteSet } from 'svelte/reactivity';
  import {
    IconArchive,
    IconArrowLeft,
    IconArrowRight,
    IconChevronDown,
    IconLayoutGrid,
    IconPhoto,
    IconPlus,
    IconUpload,
  } from '@tabler/icons-svelte';
  import { backend, browser, portalProps } from '$lib/host';
  import { buzzMode } from '$lib/buzz-mode.svelte';
  import { pool } from '$lib/pool';
  import { blobPreviewUrl } from '$lib/reuse';
  import { isAbort } from '$lib/upload';
  import type { EditGenerationItem, EditImageOption } from '$lib/edit-helpers-core';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import * as Dialog from '@civitai/ui/components/ui/dialog/index.js';
  import * as DropdownMenu from '@civitai/ui/components/ui/dropdown-menu/index.js';
  import { ToggleGroup, ToggleGroupItem } from '@civitai/ui/components/ui/toggle-group/index.js';
  import EditPairCard from './EditPairCard.svelte';
  import EditImportDialog from './EditImportDialog.svelte';
  import EditGenerationPickerModal from './EditGenerationPickerModal.svelte';
  import CreateAfterDialog from './CreateAfterDialog.svelte';
  import { blobAirFromUrl, nextImgId, plural, type Img } from './trainingFlow';
  import { fileDrop, isZip, pickedFiles } from './fileDrop';
  import { inFlight, uploadedFields, uploadTile } from './tileUpload';
  import {
    blobImg,
    groupByStart,
    hashFile,
    isPairReady,
    localImg,
    nextPairId,
    pairImgs,
    pairProblem,
    pollUntilDone,
    RECOMMENDED_PAIRS,
    startKey,
    type EditPair,
    type ImportedPair,
  } from './editPairs';

  let {
    pairs = $bindable([]),
    onContinue,
    onBack,
  }: {
    pairs: EditPair[];
    onContinue: () => void;
    onBack: () => void;
  } = $props();

  type Side = 'before' | 'after';
  type Filter = 'all' | 'attention' | 'upload' | 'gen' | `zip:${string}`;

  let view = $state<'pairs' | 'group'>('pairs');
  let filter = $state<Filter>('all');
  let notice = $state('');
  let dragging = $state(false);

  let fileInput: HTMLInputElement;
  let zipInput: HTMLInputElement;
  let afterInput: HTMLInputElement;
  let afterTarget: number | null = null;

  let importOpen = $state(false);
  let importFile = $state<File | null>(null);
  let gensOpen = $state(false);
  let createOpen = $state(false);
  let createId = $state<number | null>(null);
  let setAllOpen = $state(false);
  let setAllText = $state('');

  const suggesting = new SvelteSet<number>();
  // Keyed `<pairId>:<side>` for uploads and `<pairId>:suggest` for a suggestion.
  const requests = inFlight<string>();
  // Leaving the step aborts every upload; the pairs outlive it (the flow owns them), so an interrupted
  // image is left failed-with-Retry rather than frozen mid-upload, and queued ones never start.
  let left = false;
  $effect(() => () => {
    left = true;
    requests.abortAll();
    for (const pair of pairs)
      for (const img of pairImgs(pair))
        if (img.status === 'uploading' && img.file)
          Object.assign(img, { status: 'error', message: 'Upload interrupted' });
  });

  const suggestPrice = $derived(browser ? backend().suggestQuote() : null);

  // Mutate through `pairs` (the state proxy), never a captured object, so the change renders.
  const pairById = (id: number) => pairs.find((p) => p.id === id);
  function patchImg(id: number, side: Side, values: Partial<Img>) {
    const img = pairById(id)?.[side];
    if (img) Object.assign(img, values);
  }

  async function uploadSide(id: number, side: Side) {
    const file = pairById(id)?.[side]?.file;
    if (!file || left) return;
    const blob = await requests.run(`${id}:${side}`, (signal) =>
      uploadTile(file, (values) => patchImg(id, side, values), signal)
    );
    if (blob) patchImg(id, side, uploadedFields(blob));
  }

  async function uploadAll(targets: { id: number; side: Side }[]) {
    await pool(targets, 4, (t) => uploadSide(t.id, t.side));
  }

  async function withHash(img: Img): Promise<Img> {
    return img.file ? { ...img, hash: await hashFile(img.file) } : img;
  }

  async function addStarts(files: File[]) {
    const images = files.filter((f) => f.type.startsWith('image/'));
    if (images.length === 0) return;
    const added: EditPair[] = await Promise.all(
      images.map(async (file) => ({
        id: nextPairId(),
        before: await withHash(localImg(file)),
        instruction: '',
        source: 'upload' as const,
      }))
    );
    pairs = [...pairs, ...added];
    filter = 'all';
    notice =
      added.length === 1
        ? `${added[0]!.before.name} added — now add its after image.`
        : `${added.length} starting images added — now add their after images.`;
    await uploadAll(added.map((p) => ({ id: p.id, side: 'before' })));
  }

  function setAfter(id: number, file: File) {
    const pair = pairById(id);
    if (!pair || !file.type.startsWith('image/')) return;
    if (pair.after) revoke(pair.after, id);
    pair.after = localImg(file);
    void uploadSide(id, 'after');
  }

  function importPairs(imported: ImportedPair[], defaultInstruction: string) {
    const name = importFile?.name ?? 'dataset.zip';
    const added: EditPair[] = imported.map((p) => ({
      id: nextPairId(),
      before: { ...localImg(p.before), hash: p.beforeHash },
      after: p.after ? localImg(p.after) : undefined,
      instruction: p.instruction ?? defaultInstruction,
      source: 'zip',
      sourceName: name,
    }));
    pairs = [...pairs, ...added];
    filter = 'all';
    notice = `${plural(added.length, 'pair')} added from ${name}.`;
    void uploadAll(
      added.flatMap((p) => [
        { id: p.id, side: 'before' as const },
        ...(p.after ? [{ id: p.id, side: 'after' as const }] : []),
      ])
    );
  }

  // Already scanned blobs: no upload. The starting image's URL needs the workflow's authorisation to
  // display, so its preview is fetched afterwards; `blobUrl` stays the orchestrator URL the edit was
  // made from — it is what samples, suggestions and new edits are sent.
  function addFromGenerations(items: EditGenerationItem[]) {
    const have = new Set(pairs.map((p) => p.after?.blobId).filter(Boolean));
    const added: EditPair[] = items
      .filter((item) => !have.has(item.resultBlobId))
      .map((item) => ({
        id: nextPairId(),
        before: blobImg({
          name: item.sourceUrl.split('?')[0]!.split('/').pop() ?? 'start',
          previewUrl: '',
          blobId: blobAirFromUrl(item.sourceUrl),
          blobUrl: item.sourceUrl,
          sourceWorkflowId: item.workflowId,
        }),
        after: blobImg({
          name: `${item.resultBlobId}`,
          // The full image, not the picker's preview: the zip reads its bytes from here first.
          previewUrl: item.resultUrl,
          sourceWorkflowId: item.workflowId,
          blobId: item.resultBlobId,
          blobUrl: item.resultUrl,
          nsfwLevel: item.nsfwLevel,
        }),
        instruction: item.prompt,
        source: 'gen',
      }));
    if (added.length === 0) return;
    pairs = [...pairs, ...added];
    filter = 'all';
    notice = `${plural(added.length, 'pair')} added from your generations.`;
    void pool(added, 4, async (p) => {
      const url = await blobPreviewUrl(p.before.blobUrl!, p.before.sourceWorkflowId!);
      if (!url) return;
      if (!pairById(p.id)) return URL.revokeObjectURL(url);
      patchImg(p.id, 'before', { previewUrl: url });
    });
  }

  function useCreated(option: EditImageOption, prompt: string, workflowId: string) {
    const pair = createId === null ? undefined : pairById(createId);
    if (!pair) return;
    pair.after = blobImg({
      name: option.blobId,
      previewUrl: option.url,
      blobId: option.blobId,
      blobUrl: option.url,
      nsfwLevel: option.nsfwLevel,
      sourceWorkflowId: workflowId,
    });
    if (!pair.instruction.trim()) pair.instruction = prompt;
  }

  async function suggest(id: number) {
    const pair = pairById(id);
    if (!pair?.after?.blobUrl || !pair.before.blobUrl || suggesting.has(id)) return;
    const beforeUrl = pair.before.blobUrl;
    const afterUrl = pair.after.blobUrl;
    suggesting.add(id);
    await requests.run(`${id}:suggest`, async (signal) => {
      try {
        const { workflowId } = await backend().suggestSubmit({
          beforeUrl,
          afterUrl,
          currencies: buzzMode.currencies,
        });
        const { text } = await pollUntilDone(
          (pollSignal) => backend().suggestPoll(workflowId, pollSignal),
          signal
        );
        const current = pairById(id);
        // Typed in while it ran: the user's own words win.
        if (current && !current.instruction.trim()) {
          if (text) current.instruction = text;
          else notice = "Couldn't suggest an instruction for that pair — write it yourself.";
        }
      } catch (err) {
        if (!isAbort(err) && !signal.aborted)
          notice = err instanceof Error ? err.message : "Couldn't suggest an instruction.";
      } finally {
        suggesting.delete(id);
      }
    });
  }

  // A preview may be shared by pairs that start from the same image (`addEditFrom`), so it is only
  // freed once no other pair shows it.
  function revoke(img: Img, leaving: number | null = null) {
    if (!img.previewUrl.startsWith('blob:')) return;
    const shown = pairs.some(
      (p) => p.id !== leaving && (p.before.previewUrl === img.previewUrl || p.after?.previewUrl === img.previewUrl)
    );
    if (!shown) URL.revokeObjectURL(img.previewUrl);
  }

  function removePair(id: number) {
    for (const key of [`${id}:before`, `${id}:after`, `${id}:suggest`]) requests.abort(key);
    const pair = pairById(id);
    if (pair) {
      revoke(pair.before, id);
      if (pair.after) revoke(pair.after, id);
    }
    pairs = pairs.filter((p) => p.id !== id);
  }

  function addEditFrom(pair: EditPair) {
    // The copy shares the start's blob, so it must have one: a start still uploading or failed would
    // leave the copy frozen in that state.
    if (pair.before.status !== 'uploaded') return;
    pairs = [
      ...pairs,
      {
        id: nextPairId(),
        // The start is already uploaded: the copy shares its blob (and preview), never its File, so it
        // has nothing to re-upload or retry.
        before: { ...pair.before, id: nextImgId(), file: undefined },
        instruction: '',
        source: pair.source,
        sourceName: pair.sourceName,
      },
    ];
  }

  function applyToAll(onlyEmpty: boolean) {
    const text = setAllText.trim();
    if (!text) return;
    for (const pair of pairs) if (!onlyEmpty || !pair.instruction.trim()) pair.instruction = text;
    setAllOpen = false;
  }

  function openImport(file: File) {
    importFile = file;
    importOpen = true;
  }
  function takeFiles(files: File[]) {
    const zip = files.find(isZip);
    if (zip) openImport(zip);
    void addStarts(files.filter((f) => !isZip(f)));
  }

  const drop = fileDrop((v) => (dragging = v), takeFiles);

  const sourceLabel = (p: EditPair) =>
    p.source === 'zip' ? (p.sourceName ?? 'Imported zip') : p.source === 'gen' ? 'Generator' : 'Uploaded';

  const needsAttention = (p: EditPair) => {
    const problem = pairProblem(p);
    return problem !== null && problem !== 'uploading';
  };
  const attentionCount = $derived(pairs.filter(needsAttention).length);
  const uploading = $derived(pairs.some((p) => pairProblem(p) === 'uploading'));
  const readyCount = $derived(pairs.filter(isPairReady).length);
  const canContinue = $derived(pairs.length > 0 && readyCount === pairs.length);

  const filters = $derived.by(() => {
    const out: { id: Filter; label: string }[] = [{ id: 'all', label: `All · ${pairs.length}` }];
    if (attentionCount) out.push({ id: 'attention', label: `Needs attention · ${attentionCount}` });
    const zips = new Map<string, number>();
    for (const p of pairs)
      if (p.source === 'zip') zips.set(p.sourceName ?? '', (zips.get(p.sourceName ?? '') ?? 0) + 1);
    for (const [name, n] of zips) out.push({ id: `zip:${name}`, label: `${name || 'Imported zip'} · ${n}` });
    const uploads = pairs.filter((p) => p.source === 'upload').length;
    if (uploads) out.push({ id: 'upload', label: `Uploaded · ${uploads}` });
    const gens = pairs.filter((p) => p.source === 'gen').length;
    if (gens) out.push({ id: 'gen', label: `Generator · ${gens}` });
    return out;
  });
  // A filter whose last pair went away falls back to everything rather than an empty view.
  const activeFilter = $derived<Filter>(filters.some((f) => f.id === filter) ? filter : 'all');
  const visible = $derived(
    pairs.filter((p) =>
      activeFilter === 'all'
        ? true
        : activeFilter === 'attention'
          ? needsAttention(p)
          : activeFilter.startsWith('zip:')
            ? p.source === 'zip' && `zip:${p.sourceName ?? ''}` === activeFilter
            : p.source === activeFilter
    )
  );
  const grouped = $derived(groupByStart(visible));
  const knownStarts = $derived(new Set(pairs.map(startKey).filter((k): k is string => !!k)));
  const emptyCount = $derived(pairs.filter((p) => !p.instruction.trim()).length);
  const createPair = $derived(createId === null ? null : (pairById(createId) ?? null));
</script>

{#snippet card(pair: EditPair, showBefore: boolean)}
  {#if suggestPrice}
    {#await suggestPrice}
      {@render cardWithPrice(pair, showBefore, null)}
    {:then price}
      {@render cardWithPrice(pair, showBefore, price)}
    {:catch}
      <!-- Unpriced: Suggest still works, the button just can't name its cost. -->
      {@render cardWithPrice(pair, showBefore, null)}
    {/await}
  {:else}
    {@render cardWithPrice(pair, showBefore, null)}
  {/if}
{/snippet}

{#snippet cardWithPrice(pair: EditPair, showBefore: boolean, price: number | null)}
  <EditPairCard
    {pair}
    {showBefore}
    sourceLabel={sourceLabel(pair)}
    suggesting={suggesting.has(pair.id)}
    suggestPrice={price}
    onInstruction={(text) => (pair.instruction = text)}
    onRemove={() => removePair(pair.id)}
    onUploadAfter={() => {
      afterTarget = pair.id;
      afterInput.click();
    }}
    onCreate={() => {
      createId = pair.id;
      createOpen = true;
    }}
    onSuggest={() => suggest(pair.id)}
    onRetry={(side) => uploadSide(pair.id, side)}
  />
{/snippet}

<!-- The whole step is a drop target; the visible drop zone below is its keyboard/click entry. -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="relative flex flex-col gap-5" {...drop}>
  <div class="flex flex-wrap items-end justify-between gap-4">
    <div class="min-w-0">
      <h2 class="m-0 text-xl font-semibold text-white">Build your edit dataset</h2>
      <p class="mt-1 max-w-2xl text-sm text-dark-2">
        Each pair is a before image, the after image, and the instruction that turns one into the
        other. Upload images, import a dataset, or both.
      </p>
    </div>
    <div class="flex flex-wrap gap-2">
      <Button variant="outline" onclick={() => zipInput.click()}>
        <IconArchive size={15} stroke={2} class="mr-1.5 inline" />Import dataset
      </Button>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger>
          {#snippet child({ props })}
            <Button {...props}>
              <IconPlus size={15} stroke={2} class="mr-1.5 inline" />Add pairs<IconChevronDown
                size={14}
                stroke={2}
                class="ml-1 inline"
              />
            </Button>
          {/snippet}
        </DropdownMenu.Trigger>
        <DropdownMenu.Content align="end" class="w-72" portalProps={portalProps()}>
          <DropdownMenu.Item onSelect={() => fileInput.click()} class="items-start gap-2.5 py-2">
            <IconUpload size={16} stroke={2} class="mt-0.5 text-primary" />
            <span>
              <span class="block text-sm text-dark-0">Upload images</span>
              <span class="block text-xs text-dark-2">Add starting images, then their after images</span>
            </span>
          </DropdownMenu.Item>
          <DropdownMenu.Item onSelect={() => (gensOpen = true)} class="items-start gap-2.5 py-2">
            <IconPhoto size={16} stroke={2} class="mt-0.5 text-primary" />
            <span>
              <span class="block text-sm text-dark-0">From my edit generations</span>
              <span class="block text-xs text-dark-2">Start, result and prompt come in as a ready pair</span>
            </span>
          </DropdownMenu.Item>
          <DropdownMenu.Item onSelect={() => zipInput.click()} class="items-start gap-2.5 py-2">
            <IconArchive size={16} stroke={2} class="mt-0.5 text-primary" />
            <span>
              <span class="block text-sm text-dark-0">Import a dataset</span>
              <span class="block text-xs text-dark-2">A .zip of before/after folders you already have</span>
            </span>
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Root>
    </div>
  </div>

  <input bind:this={fileInput} type="file" multiple accept="image/*" class="hidden" onchange={(e) => takeFiles(pickedFiles(e))} />
  <input bind:this={zipInput} type="file" accept=".zip,application/zip" class="hidden" onchange={(e) => {
    const [zip] = pickedFiles(e);
    if (zip) openImport(zip);
  }} />
  <input
    bind:this={afterInput}
    type="file"
    accept="image/*"
    class="hidden"
    onchange={(e) => {
      const [file] = pickedFiles(e);
      if (afterTarget !== null && file) setAfter(afterTarget, file);
      afterTarget = null;
    }}
  />

  {#if notice}
    <p class="m-0 text-sm text-dark-2" role="status">{notice}</p>
  {/if}

  {#if pairs.length > 0}
    <div class="flex flex-col gap-2.5 rounded-xl border border-dark-4 bg-dark-6 px-4 py-3">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div class="flex flex-wrap items-baseline gap-3">
          <span class="font-semibold text-dark-0">{plural(pairs.length, 'pair')}</span>
          <span class="text-xs text-dark-2">
            {pairs.length >= RECOMMENDED_PAIRS
              ? 'A good size for a first run'
              : `${RECOMMENDED_PAIRS} or more recommended · ${RECOMMENDED_PAIRS - pairs.length} to go`}
          </span>
        </div>
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          bind:value={
            () => view,
            (v) => {
              if (v === 'pairs' || v === 'group') view = v;
            }
          }
        >
          <ToggleGroupItem value="pairs" aria-label="Show every pair">Pairs</ToggleGroupItem>
          <ToggleGroupItem value="group" aria-label="Group pairs by starting image">
            <IconLayoutGrid size={14} stroke={2} class="mr-1 inline" />Group by starting image
          </ToggleGroupItem>
        </ToggleGroup>
      </div>
      <div class="flex flex-wrap items-center justify-between gap-2">
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          aria-label="Filter pairs"
          class="flex-wrap"
          bind:value={
            () => activeFilter,
            (v) => {
              // Ignores the '' a same-item deselect click emits.
              if (v) filter = v as Filter;
            }
          }
        >
          {#each filters as f (f.id)}
            <ToggleGroupItem value={f.id} class={f.id === 'attention' ? 'text-amber-400' : ''}>
              {f.label}
            </ToggleGroupItem>
          {/each}
        </ToggleGroup>
        <Button variant="ghost" size="sm" onclick={() => ((setAllText = ''), (setAllOpen = true))}>
          Set one instruction for all
        </Button>
      </div>
    </div>
  {/if}

  {#if pairs.length > 0 && visible.length === 0}
    <div class="rounded-xl border border-dark-4 bg-dark-6 p-8 text-center text-sm text-dark-2">
      Nothing here for this filter.
    </div>
  {/if}

  {#if view === 'pairs'}
    <div class="grid gap-3 lg:grid-cols-2">
      {#each visible as pair (pair.id)}
        {@render card(pair, true)}
      {/each}
    </div>
  {:else}
    {#each grouped.groups as group (group.key)}
      {@const start = group.pairs[0]!.before}
      <section class="flex flex-wrap items-start gap-4 rounded-xl border border-dark-4 bg-dark-6 p-3">
        <div class="flex w-28 shrink-0 flex-col gap-1">
          <div class="h-28 w-28 overflow-hidden rounded-lg border border-dark-4 bg-dark-7">
            {#if start.previewUrl}<img src={start.previewUrl} alt="" class="h-full w-full object-cover" />{/if}
          </div>
          <span class="truncate font-mono text-[11px] text-dark-2" title={start.name}>{start.name}</span>
          <span class="font-mono text-xs uppercase tracking-wider text-dark-2">{group.pairs.length} pairs</span>
        </div>
        <div class="flex min-w-0 flex-1 flex-col gap-2">
          <div class="grid gap-2.5 xl:grid-cols-2">
            {#each group.pairs as pair (pair.id)}
              {@render card(pair, false)}
            {/each}
          </div>
          <div>
            <Button
              variant="ghost"
              size="sm"
              disabled={start.status !== 'uploaded'}
              title={start.status === 'uploaded' ? undefined : 'Available once the starting image has uploaded'}
              onclick={() => addEditFrom(group.pairs[0]!)}
            >
              <IconPlus size={14} stroke={2} class="mr-1 inline" />Add another edit from this image
            </Button>
          </div>
        </div>
      </section>
    {/each}
    {#if grouped.groups.length === 0 && visible.length > 0}
      <div class="rounded-xl border border-dark-4 bg-dark-6 p-5 text-sm text-dark-2">
        No starting image is used more than once yet.
      </div>
    {/if}
    {#if grouped.singles.length > 0}
      <details class="group rounded-xl border border-dark-4 bg-dark-6">
        <summary class="flex items-center justify-between px-4 py-3 text-sm text-dark-0">
          <span>
            {plural(grouped.singles.length, 'pair')} with their own starting image
          </span>
          <IconChevronDown size={15} stroke={2} class="text-dark-2 transition group-open:rotate-180" />
        </summary>
        <div class="grid gap-3 p-3 pt-0 lg:grid-cols-2">
          {#each grouped.singles as pair (pair.id)}
            {@render card(pair, true)}
          {/each}
        </div>
      </details>
    {/if}
  {/if}

  <button
    type="button"
    onclick={() => fileInput.click()}
    class="flex min-h-24 flex-col items-center justify-center gap-1 rounded-xl border border-dashed p-4 text-center transition
      {dragging ? 'border-primary bg-primary/5' : 'border-dark-3 hover:border-dark-2'}"
  >
    <span class="text-sm font-semibold text-dark-0">
      {pairs.length ? 'Drop more images, or a dataset .zip' : 'Drop starting images, or a dataset .zip'}
    </span>
    <span class="text-sm text-dark-2">
      Everything joins this list. Imported pairs sit next to the ones you uploaded.
    </span>
  </button>

  <div class="flex items-center justify-between gap-3 border-t border-dark-4 pt-5">
    <Button variant="outline" onclick={onBack}>
      <IconArrowLeft size={15} stroke={2} class="mr-1.5 inline" />Back
    </Button>
    <div class="flex items-center gap-3">
      {#if attentionCount > 0}
        <button
          id="edit-continue-blocked"
          type="button"
          onclick={() => (filter = 'attention')}
          class="font-mono text-xs text-buzz underline decoration-dotted underline-offset-2"
        >
          Fix {plural(attentionCount, 'pair')} to continue, or remove {attentionCount === 1 ? 'it' : 'them'}
        </button>
      {:else if uploading}
        <span class="font-mono text-xs text-dark-2">Uploading…</span>
      {/if}
      <Button
        disabled={!canContinue}
        onclick={onContinue}
        aria-describedby={attentionCount > 0 ? 'edit-continue-blocked' : undefined}
      >
        Continue to review<IconArrowRight size={15} stroke={2} class="ml-1.5 inline" />
      </Button>
    </div>
  </div>
</div>

<EditImportDialog bind:open={importOpen} file={importFile} {knownStarts} onImport={importPairs} />
<EditGenerationPickerModal bind:open={gensOpen} onAdd={addFromGenerations} />
<CreateAfterDialog bind:open={createOpen} pair={createPair} onUse={useCreated} />

<Dialog.Root bind:open={setAllOpen}>
  <Dialog.Content class="sm:max-w-md" portalProps={portalProps()}>
    <Dialog.Header>
      <Dialog.Title>One instruction for every pair</Dialog.Title>
      <Dialog.Description>
        Useful when every pair shows the same edit. You can still change any pair afterwards.
      </Dialog.Description>
    </Dialog.Header>
    <label for="set-all" class="font-mono text-xs uppercase tracking-wider text-dark-2">Instruction</label>
    <Input id="set-all" bind:value={setAllText} placeholder="e.g. Put the logo on the product" />
    <Dialog.Footer>
      <Button variant="outline" onclick={() => applyToAll(true)} disabled={!setAllText.trim() || emptyCount === 0}>
        Fill {emptyCount} empty
      </Button>
      <Button onclick={() => applyToAll(false)} disabled={!setAllText.trim()}>
        Replace all {pairs.length}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
