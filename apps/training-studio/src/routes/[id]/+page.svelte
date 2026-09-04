<script lang="ts">
  import { browser } from '$app/environment';
  import { invalidate } from '$app/navigation';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import { ToggleGroup, ToggleGroupItem } from '@civitai/ui/components/ui/toggle-group/index.js';
  import { postRename } from '$lib/train';
  import AppHeader from '$lib/components/AppHeader.svelte';
  import ModelCodeBadge from '$lib/components/ModelCodeBadge.svelte';
  import TrainingTrace from '$lib/components/TrainingTrace.svelte';
  import RunStateBadge from '$lib/components/RunStateBadge.svelte';
  import SampleImage from '$lib/components/SampleImage.svelte';
  import SampleViewer from '$lib/components/SampleViewer.svelte';
  import type { TrainingDetailEpoch } from '$lib/data/trainingRows';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
  const d = $derived(data.detail);

  // Overall, monotonic training progress. The orchestrator's estimatedProgressRate is PER-EPOCH — it runs
  // 0→1 for the current epoch's job and restarts each epoch — so folding it into the count of finished
  // checkpoints gives a whole-run reading that climbs instead of resetting. Falls back to the raw rate, or
  // to finished/planned, when a piece is missing.
  const completedEpochs = $derived(d.epochs.length);
  const progressPct = $derived.by(() => {
    const planned = d.plannedEpochs ?? 0;
    const rate = typeof d.progress === 'number' ? d.progress : 0;
    if (planned > 0) return Math.min(100, Math.round(((completedEpochs + rate) / planned) * 100));
    return typeof d.progress === 'number' ? Math.round(d.progress * 100) : 0;
  });

  // Live updates while training: re-run the load every few seconds so new epochs/samples stream in. The
  // one-shot timeout re-arms via this effect after each refetch and stops on its own once the run reaches
  // a terminal state (the guard fails, so no new timeout is set).
  const POLL_MS = 5000;
  $effect(() => {
    if (!browser || d.state !== 'training') return;
    const timer = setTimeout(() => invalidate('app:training-detail'), POLL_MS);
    return () => clearTimeout(timer);
  });

  // Inline rename of the run title (updates metadata + name tag on the workflow).
  let renaming = $state(false);
  let draft = $state('');
  let saving = $state(false);
  let renameError = $state('');

  function startRename() {
    draft = d.name;
    renameError = '';
    renaming = true;
  }
  function focusInput(node: HTMLElement) {
    queueMicrotask(() => node.querySelector('input')?.focus());
  }
  async function saveRename(e: SubmitEvent) {
    e.preventDefault();
    const name = draft.trim();
    if (!name || saving) return;
    saving = true;
    renameError = '';
    try {
      await postRename(d.workflowId, name);
      await invalidate('app:training-detail'); // re-read the title from the server
      renaming = false;
    } catch (err) {
      renameError = err instanceof Error ? err.message : 'Could not rename';
    } finally {
      saving = false;
    }
  }

  const createdLabel = $derived(
    new Date(d.createdAt).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    })
  );

  // Row labels for the samples: the fixed prompts, falling back to a positional label when a run carries
  // none. Length drives how many sample slots each epoch renders.
  const promptLabels = $derived(
    d.prompts.length ? d.prompts : d.epochs[0]?.samples.map((_, i) => `Sample ${i + 1}`) ?? []
  );

  // Newest-first for the featured view + selector; oldest-first for the compare matrix so it reads as an
  // evolution left→right.
  const newestFirst = $derived([...d.epochs].sort((a, b) => b.number - a.number));
  const oldestFirst = $derived([...d.epochs].sort((a, b) => a.number - b.number));

  // Highest-numbered checkpoint with downloadable weights is recommended; fall back to the newest when
  // none carry a model blob yet (a still-training run).
  const recommended = $derived.by<TrainingDetailEpoch | null>(() => {
    if (newestFirst.length === 0) return null;
    return newestFirst.find((e) => e.modelUrl) ?? newestFirst[0];
  });

  // The user's chosen checkpoint drives the featured view. `null` follows the recommended one. Resolving
  // the id against the CURRENT run's epochs means a stale id carried across a /[id]→/[id] navigation just
  // falls back to recommended — no reseed needed.
  let selectedId = $state<string | null>(null);
  const featured = $derived(newestFirst.find((e) => e.id === selectedId) ?? recommended);

  let mode = $state<'epoch' | 'compare'>('epoch');
  const showCompare = $derived(mode === 'compare' && newestFirst.length > 1);

  // The fullscreen viewer navigates over `newestFirst` (↑ = newer epoch, matching the in-app trainer).
  let viewer = $state<{ epochIndex: number; sampleIndex: number } | null>(null);
  function openViewer(epoch: TrainingDetailEpoch, sampleIndex: number) {
    const epochIndex = newestFirst.indexOf(epoch);
    if (epochIndex !== -1) viewer = { epochIndex, sampleIndex };
  }

  // A param-only /[id]→/[id'] navigation reuses this component, so the viewer would keep an index into the
  // previous run's epochs — close it when the run changes.
  $effect(() => {
    void d.workflowId;
    viewer = null;
  });
</script>

<AppHeader username={data.username} />

<section class="flex flex-col gap-6">
  <a href="/" class="font-mono text-xs text-dark-2 transition-colors hover:text-white">
    ← My trainings
  </a>

  <header class="rounded-md border border-dark-4 bg-dark-6 p-5">
    <div class="flex flex-wrap items-start gap-4">
      <ModelCodeBadge code={d.code} size="lg" />
      <div class="min-w-0 flex-1">
        {#if renaming}
          <form class="flex flex-wrap items-center gap-2" onsubmit={saveRename} use:focusInput>
            <Input
              bind:value={draft}
              aria-label="Training name"
              class="h-9 max-w-sm text-lg font-semibold"
            />
            <Button type="submit" size="sm" disabled={saving || !draft.trim()}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
            <Button type="button" variant="ghost" size="sm" onclick={() => (renaming = false)}>
              Cancel
            </Button>
          </form>
          {#if renameError}
            <p class="mt-1 font-mono text-[11px] text-red-400">{renameError}</p>
          {/if}
        {:else}
          <div class="flex items-center gap-2">
            <h1 class="m-0 truncate text-2xl font-semibold text-white">{d.name}</h1>
            <button
              type="button"
              aria-label="Rename training"
              onclick={startRename}
              class="shrink-0 rounded p-1 text-dark-2 transition-colors hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              ✎
            </button>
          </div>
        {/if}
        <div class="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-dark-2">
          <span class="text-dark-0">{d.base}</span>
        </div>
      </div>
      <RunStateBadge state={d.state} />
    </div>

    <dl class="mt-4 flex flex-wrap gap-x-8 gap-y-2 border-t border-dark-4 pt-4 font-mono text-[11px]">
      <div class="flex items-center gap-1.5">
        <dt class="text-dark-2">Checkpoints</dt>
        <dd class="m-0 text-dark-0">
          {d.epochs.length}{#if d.state === 'training' && d.plannedEpochs} / {d.plannedEpochs}{/if}
        </dd>
      </div>
      <div class="flex items-center gap-1.5">
        <dt class="text-dark-2">Created</dt>
        <dd class="m-0 text-dark-0">{createdLabel}</dd>
      </div>
      <div class="flex items-center gap-1.5">
        <dt class="text-dark-2">Base model</dt>
        <dd class="m-0 text-dark-0">{d.base}</dd>
      </div>
    </dl>
  </header>

  {#if d.state === 'training'}
    <div class="rounded-md border border-dark-4 bg-dark-6 p-4">
      <div class="mb-2 flex items-center justify-between text-sm">
        <span class="flex items-center gap-2 font-semibold text-dark-0">
          <span class="h-2 w-2 animate-pulse rounded-full bg-primary"></span>
          Training progress
        </span>
        <span class="font-mono text-dark-2">
          {progressPct}%{#if d.plannedEpochs} · epoch {completedEpochs} / {d.plannedEpochs}{/if}
        </span>
      </div>
      <div
        class="h-2 overflow-hidden rounded-full bg-dark-7"
        role="progressbar"
        aria-valuenow={progressPct}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div class="h-full rounded-full bg-primary transition-[width]" style:width="{progressPct}%"></div>
      </div>
    </div>
  {/if}

  {#if d.state === 'training' && d.liveTraceUrl}
    <TrainingTrace traceUrl={d.liveTraceUrl} />
  {/if}

  {#if d.state === 'failed'}
    <div class="rounded-md border border-red-500/20 bg-red-500/5 p-8 text-center">
      <div class="text-3xl">⚠️</div>
      <h2 class="mt-3 text-base font-semibold text-white">This training didn't complete</h2>
      <p class="mx-auto mt-1 max-w-md text-sm text-dark-2">
        No weights were produced. If Buzz was charged for this run it's refunded automatically — nothing
        to publish or download here.
      </p>
    </div>
  {:else if d.epochs.length === 0}
    <div class="rounded-md border border-dashed border-dark-4 bg-dark-6 p-10 text-center">
      {#if d.state === 'training'}
        <div class="flex items-center justify-center gap-2 text-sm font-medium text-primary">
          <span class="h-2.5 w-2.5 animate-pulse rounded-full bg-primary"></span>
          Training in progress
        </div>
        <p class="mx-auto mt-2 max-w-md text-sm text-dark-2">
          {#if d.plannedEpochs}0 of {d.plannedEpochs} checkpoints so far — {/if}sample images and
          downloadable weights stream in here as each epoch finishes.
        </p>
      {:else}
        <p class="text-sm text-dark-2">No checkpoints yet. Samples appear here as the run produces them.</p>
      {/if}
    </div>
  {:else}
    {#if newestFirst.length > 1}
      <ToggleGroup
        type="single"
        value={mode}
        onValueChange={(v) => {
          if (v === 'epoch' || v === 'compare') mode = v;
        }}
        variant="outline"
        size="sm"
        class="self-start"
      >
        <ToggleGroupItem value="epoch" aria-label="View one epoch">Epoch</ToggleGroupItem>
        <ToggleGroupItem value="compare" aria-label="Compare epochs">Compare epochs</ToggleGroupItem>
      </ToggleGroup>
    {/if}

    {#if showCompare}
      <div class="rounded-md border border-dark-4 bg-dark-6 p-5">
        <p class="mb-4 text-[11px] text-dark-2">
          Each prompt across every checkpoint — scan a row to see how a sample evolved. Click a checkpoint
          to open and download it.
        </p>
        <div class="overflow-x-auto">
          <div
            class="grid gap-2"
            style="grid-template-columns: minmax(150px, 190px) repeat({oldestFirst.length}, 116px)"
          >
            <div></div>
            {#each oldestFirst as epoch (epoch.id)}
              <button
                type="button"
                onclick={() => {
                  selectedId = epoch.id;
                  mode = 'epoch';
                }}
                class="flex items-center justify-center gap-1 rounded px-1 py-1 text-[11px] font-semibold transition-colors {epoch ===
                recommended
                  ? 'text-[#f59f00] hover:bg-[#f59f00]/10'
                  : 'text-dark-0 hover:bg-dark-5'}"
                title="Open epoch {epoch.number}"
              >
                {#if epoch === recommended}★{/if}Epoch {epoch.number}
              </button>
            {/each}

            {#each promptLabels as prompt, r (r)}
              <div
                class="flex items-center pr-2 text-[11px] leading-relaxed text-dark-2"
                title={prompt}
              >
                <span class="line-clamp-4">{prompt}</span>
              </div>
              {#each oldestFirst as epoch (epoch.id)}
                {@const cellUrl = epoch.samples[r] ?? null}
                {#if cellUrl}
                  <button
                    type="button"
                    onclick={() => openViewer(epoch, r)}
                    class="block w-full cursor-zoom-in rounded transition hover:ring-2 hover:ring-primary/50"
                    aria-label="Open Epoch {epoch.number}, prompt {r + 1}"
                  >
                    <SampleImage url={cellUrl} alt="Epoch {epoch.number}, prompt {r + 1}" />
                  </button>
                {:else}
                  <SampleImage url={null} />
                {/if}
              {/each}
            {/each}
          </div>
        </div>
      </div>
    {:else if featured}
      <div class="rounded-md border border-dark-4 bg-dark-6 p-5">
        <div class="mb-4 flex flex-wrap items-center gap-3">
          <div class="flex items-baseline gap-2">
            <h2 class="m-0 text-lg font-semibold text-white">Epoch {featured.number}</h2>
            {#if featured === recommended}
              <span
                class="rounded bg-[#f59f00]/15 px-2 py-0.5 text-[10px] font-semibold text-[#f59f00]"
              >
                ★ Recommended
              </span>
            {/if}
          </div>
          {#if featured.modelUrl}
            <a
              href={featured.modelUrl}
              download
              class="ml-auto inline-flex items-center gap-1.5 rounded bg-primary px-3 py-1.5 text-[13px] font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
            >
              ↓ Download weights
            </a>
          {:else}
            <span
              class="ml-auto rounded border border-dark-4 px-3 py-1.5 font-mono text-[11px] text-dark-2"
            >
              Weights not ready
            </span>
          {/if}
        </div>

        <div class="grid grid-cols-1 gap-4 sm:grid-cols-3">
          {#each promptLabels as prompt, i (i)}
            {@const featuredUrl = featured.samples[i] ?? null}
            <figure class="m-0 flex flex-col gap-2">
              {#if featuredUrl}
                <button
                  type="button"
                  onclick={() => openViewer(featured, i)}
                  class="block w-full cursor-zoom-in rounded transition hover:ring-2 hover:ring-primary/50"
                  aria-label="Open Epoch {featured.number} sample {i + 1}"
                >
                  <SampleImage url={featuredUrl} alt="Epoch {featured.number} sample {i + 1}" />
                </button>
              {:else}
                <SampleImage url={null} />
              {/if}
              <figcaption class="text-[11px] leading-relaxed text-dark-2" title={prompt}>
                {prompt}
              </figcaption>
            </figure>
          {/each}
        </div>
      </div>

      {#if newestFirst.length > 1}
        <div>
          <h3 class="mb-3 text-sm font-semibold text-dark-0">
            Checkpoints
            <span class="ml-1 font-mono text-[11px] font-normal text-dark-2">
              pick one to preview and download
            </span>
          </h3>
          <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {#each newestFirst as epoch (epoch.id)}
              {@const isSelected = epoch === featured}
              <button
                type="button"
                onclick={() => (selectedId = epoch.id)}
                aria-pressed={isSelected}
                class="rounded-md border p-3 text-left transition-colors {isSelected
                  ? 'border-primary bg-primary/5 ring-1 ring-primary/40'
                  : 'border-dark-4 bg-dark-7 hover:border-dark-3'}"
              >
                <div class="mb-2.5 flex items-center gap-2">
                  <span class="text-sm font-bold text-dark-0">Epoch {epoch.number}</span>
                  {#if epoch === recommended}
                    <span class="text-[#f59f00]" title="Recommended checkpoint">★</span>
                  {/if}
                  <span class="ml-auto font-mono text-[10px] text-dark-2">
                    {epoch.modelUrl ? 'weights ready' : 'no weights'}
                  </span>
                </div>
                <div class="grid grid-cols-3 gap-1.5">
                  {#each promptLabels as _, si (si)}
                    <SampleImage
                      url={epoch.samples[si] ?? null}
                      alt="Epoch {epoch.number} preview {si + 1}"
                    />
                  {/each}
                </div>
              </button>
            {/each}
          </div>
        </div>
      {/if}
    {/if}

    <div
      class="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-dark-4 bg-dark-7 px-4 py-3 text-[11px] text-dark-2"
    >
      <span class="font-semibold text-dark-0">Coming next</span>
      <span aria-hidden="true" class="h-3 w-px bg-dark-4"></span>
      Generate with this LoRA, publish a public model page, and train further land in an upcoming slice.
      Downloading weights is live now.
    </div>
  {/if}
</section>

{#if viewer}
  <SampleViewer
    epochs={newestFirst}
    prompts={promptLabels}
    isVideo={d.isVideo}
    epochIndex={viewer.epochIndex}
    sampleIndex={viewer.sampleIndex}
    onClose={() => (viewer = null)}
  />
{/if}
