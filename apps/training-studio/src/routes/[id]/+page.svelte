<script lang="ts">
  import { browser } from '$app/environment';
  import { invalidate, goto } from '$app/navigation';
  import JSZip from 'jszip';
  import { onSignal } from '$lib/signals';
  import { WORKFLOW_UPDATE_SIGNAL } from '$lib/signal-events';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import {
    IconPencil,
    IconCopy,
    IconCheck,
    IconAlertTriangle,
    IconStarFilled,
    IconDownload,
    IconPhoto,
    IconArchive,
    IconRepeat,
    IconArrowLeft,
  } from '@tabler/icons-svelte';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import { ToggleGroup, ToggleGroupItem } from '@civitai/ui/components/ui/toggle-group/index.js';
  import { postRename } from '$lib/train';
  import AppHeader from '$lib/components/AppHeader.svelte';
  import ModelCodeBadge from '$lib/components/ModelCodeBadge.svelte';
  import TrainingTrace from '$lib/components/TrainingTrace.svelte';
  import RunStateBadge from '$lib/components/RunStateBadge.svelte';
  import SampleImage from '$lib/components/SampleImage.svelte';
  import SampleViewer from '$lib/components/SampleViewer.svelte';
  import { overallProgressPct, type TrainingDetailEpoch } from '$lib/data/trainingRows';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
  const d = $derived(data.detail);

  // Overall, monotonic training progress. The orchestrator's estimatedProgressRate is PER-EPOCH — it runs
  // 0→1 for the current epoch's job and restarts each epoch — so folding it into the count of finished
  // checkpoints gives a whole-run reading that climbs instead of resetting. Falls back to the raw rate, or
  // to finished/planned, when a piece is missing.
  const completedEpochs = $derived(d.epochs.length);
  const progressPct = $derived(overallProgressPct(completedEpochs, d.plannedEpochs, d.progress));
  // The epoch being trained now (one past the last finished checkpoint), capped at the plan — so a run with
  // 1 checkpoint ready reads as "epoch 2", the one actually in progress, not "epoch 1".
  const currentEpoch = $derived(
    d.plannedEpochs ? Math.min(completedEpochs + 1, d.plannedEpochs) : completedEpochs + 1
  );

  // Live updates while training: re-run the load every few seconds so new epochs/samples stream in. The
  // one-shot timeout re-arms via this effect after each refetch and stops on its own once the run reaches
  // a terminal state (the guard fails, so no new timeout is set).
  const POLL_MS = 5000;
  $effect(() => {
    if (!browser || d.state !== 'training') return;
    const timer = setTimeout(() => invalidate('app:training-detail'), POLL_MS);
    return () => clearTimeout(timer);
  });

  // The push counterpart to the poll: the orchestrator emits `workflow-update` on each step (runs started
  // from this app register the callback), so a matching event refreshes immediately instead of waiting out
  // the 5s tick. The poll above stays as the fallback for runs without the callback (main-app-created, or
  // started before the callback shipped).
  $effect(() => {
    if (!browser) return;
    const workflowId = d.workflowId;
    return onSignal(WORKFLOW_UPDATE_SIGNAL, (payload) => {
      if ((payload as { workflowId?: string } | null)?.workflowId === workflowId)
        invalidate('app:training-detail');
    });
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

  // Copy the workflow id (handy for support / debugging). Shows a brief "Copied" acknowledgement.
  let copied = $state(false);
  let copiedTimer: ReturnType<typeof setTimeout> | undefined;
  async function copyWorkflowId() {
    try {
      await navigator.clipboard.writeText(d.workflowId);
      copied = true;
      clearTimeout(copiedTimer);
      copiedTimer = setTimeout(() => (copied = false), 1500);
    } catch {
      // clipboard unavailable (insecure context) — no-op; the id is in the URL as a fallback.
    }
  }

  // Relative "created" label: minutes/hours ago for a recent run, weekday-at-time within the last week,
  // otherwise the date. Recomputed on each poll so "2 minutes ago" stays honest while training.
  const createdLabel = $derived.by(() => {
    const then = new Date(d.createdAt);
    const diffMs = Date.now() - then.getTime();
    const min = Math.round(diffMs / 60000);
    if (min < 1) return 'just now';
    if (min < 60) return `${min} minute${min === 1 ? '' : 's'} ago`;
    const hr = Math.round(min / 60);
    if (hr < 24) return `${hr} hour${hr === 1 ? '' : 's'} ago`;
    if (diffMs < 7 * 86400000)
      return then.toLocaleString(undefined, { weekday: 'long', hour: 'numeric', minute: '2-digit' });
    return then.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  });

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

  // Publish hands off to the main app for the highest checkpoint that actually has weights (a still-training
  // run's newest epoch may have samples but no downloadable model yet). Null disables the button. (Generate
  // is intentionally not here: creating a throwaway draft model just to generate was rejected — the real
  // fix is teaching the on-site generator to accept a raw AIR/URL, done main-app-side.)
  const publishTarget = $derived(newestFirst.find((e) => e.modelUrl) ?? null);

  // Dataset images resolve through the authenticated proxy (a blob key / unsigned civitai URL isn't directly
  // viewable). An already-viewable absolute URL (the dev-preview stand-ins) is used as-is.
  function datasetSrc(air: string): string {
    const isAbsolute = air.startsWith('http://') || air.startsWith('https://');
    if (isAbsolute && !air.includes('/v2/consumer/blobs/') && !air.includes('civitai')) return air;
    return `/api/dataset-blob?air=${encodeURIComponent(air)}&workflowId=${encodeURIComponent(d.workflowId)}`;
  }

  const MIME_EXT: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'audio/mpeg': 'mp3',
    'audio/wav': 'wav',
  };
  // The blob's own extension (the air ends in one, e.g. `…-0.png`), falling back to the fetched mime.
  function fileExt(air: string, mime: string): string {
    const fromAir = air.split('?')[0].split('.').pop();
    if (fromAir && /^[a-z0-9]{2,4}$/i.test(fromAir) && fromAir.length <= 4) return fromAir.toLowerCase();
    return MIME_EXT[mime] ?? 'png';
  }
  function slug(s: string): string {
    return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'dataset';
  }

  // Download the training data as a standard LoRA-layout zip: each image plus a same-named .txt caption,
  // so it round-trips with the Data step's "Import .zip" and works in other trainers.
  let downloading = $state(false);
  async function downloadDataset() {
    if (downloading || !d.dataset.length) return;
    downloading = true;
    try {
      const zip = new JSZip();
      const pad = Math.max(2, String(d.dataset.length).length);
      await Promise.all(
        d.dataset.map(async (item, i) => {
          const res = await fetch(datasetSrc(item.air));
          if (!res.ok) return;
          const blob = await res.blob();
          const base = String(i + 1).padStart(pad, '0');
          zip.file(`${base}.${fileExt(item.air, blob.type)}`, blob);
          if (item.caption.trim()) zip.file(`${base}.txt`, item.caption.trim());
        })
      );
      const out = await zip.generateAsync({ type: 'blob' });
      const url = URL.createObjectURL(out);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${slug(d.name)}-dataset.zip`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      downloading = false;
    }
  }

  // Start a new training pre-loaded with this run's dataset. We reuse the blob airs directly (already
  // uploaded + scanned — no re-upload), handed to the new flow via sessionStorage; the flow pre-fills the
  // Data step once a model is picked. Captions come along; the user re-picks the model.
  function reuseDataset() {
    const payload = d.dataset.map((item, i) => ({
      air: item.air,
      caption: item.caption,
      name: `image ${i + 1}`,
      previewUrl: datasetSrc(item.air),
    }));
    sessionStorage.setItem('ts:reuse-dataset', JSON.stringify(payload));
    void goto('/new');
  }

  function openPublish() {
    if (!publishTarget) return;
    window.location.assign(
      `${data.civitaiUrl}/models/train/from-orchestrator?workflowId=${encodeURIComponent(
        d.workflowId
      )}&epoch=${publishTarget.number}`
    );
  }

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

<AppHeader username={data.username} image={data.image} logoutUrl={data.logoutUrl} buzz={data.buzz} />

<section class="flex flex-col gap-6">
  <a href="/" class="inline-flex items-center gap-1 font-mono text-xs text-dark-2 transition-colors hover:text-white">
    <IconArrowLeft size={13} stroke={2} />My trainings
  </a>

  <header class="rounded-xl border border-dark-4 bg-dark-6 p-5">
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
              class="shrink-0 rounded p-1 text-sm font-medium text-primary transition-colors hover:text-primary/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              <IconPencil size={14} stroke={2} class="mr-1 inline" />Rename
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
        <dt class="text-dark-2">Workflow</dt>
        <dd class="m-0 flex items-center gap-1.5 text-dark-0">
          <span class="max-w-[12ch] truncate" title={d.workflowId}>{d.workflowId}</span>
          <button
            type="button"
            onclick={copyWorkflowId}
            class="rounded px-1 py-0.5 font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary {copied
              ? 'text-emerald-400'
              : 'text-primary hover:text-primary/80 hover:underline'}"
            title="Copy workflow ID"
          >
            {#if copied}<IconCheck size={12} stroke={2.5} class="mr-0.5 inline" />copied{:else}<IconCopy
                size={12}
                stroke={2}
                class="mr-0.5 inline"
              />copy{/if}
          </button>
        </dd>
      </div>
    </dl>
  </header>

  {#if d.state === 'training'}
    <div class="rounded-xl border border-dark-4 bg-dark-6 p-4">
      <div class="mb-2 flex items-center justify-between text-sm">
        <span class="flex items-center gap-2 font-semibold text-dark-0">
          <span class="h-2 w-2 animate-pulse rounded-full bg-primary"></span>
          Training progress
        </span>
        <span class="font-mono text-dark-2">
          {progressPct}%{#if d.plannedEpochs} · epoch {currentEpoch} / {d.plannedEpochs}{/if}
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
    <!-- Key on the run, not the epoch: the panel persists across epoch switches (holding its last view) but
         resets cleanly when navigating to a different training. -->
    {#key d.workflowId}
      <TrainingTrace traceUrl={d.liveTraceUrl} />
    {/key}
  {/if}

  {#if d.state === 'failed'}
    <div class="rounded-xl border border-red-500/20 bg-red-500/5 p-8 text-center">
      <IconAlertTriangle size={32} stroke={1.75} class="mx-auto text-red-400" />
      <h2 class="mt-3 text-base font-semibold text-white">This training didn't complete</h2>
      <p class="mx-auto mt-1 max-w-md text-sm text-dark-2">
        No weights were produced. If Buzz was charged for this run it's refunded automatically — nothing
        to publish or download here.
      </p>
    </div>
  {:else if d.epochs.length === 0}
    <div class="rounded-xl border border-dashed border-dark-4 bg-dark-6 p-10 text-center">
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
      <div class="rounded-xl border border-dark-4 bg-dark-6 p-5">
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
                class="flex items-center justify-center gap-1 rounded border px-1.5 py-1 text-[11px] font-semibold transition-colors {epoch ===
                recommended
                  ? 'border-buzz/30 text-buzz hover:bg-buzz/10'
                  : 'border-dark-4 text-dark-0 hover:border-dark-2 hover:bg-dark-5'}"
                title="Open epoch {epoch.number}"
              >
                {#if epoch === recommended}<IconStarFilled size={11} class="inline" />{/if}Epoch {epoch.number}
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
      <div class="rounded-xl border border-dark-4 bg-dark-6 p-5">
        <div class="mb-4 flex flex-wrap items-center gap-3">
          <div class="flex items-baseline gap-2">
            <h2 class="m-0 text-lg font-semibold text-white">Epoch {featured.number}</h2>
            {#if featured === recommended}
              <span
                class="rounded bg-buzz/15 px-2 py-0.5 text-[10px] font-semibold text-buzz"
              >
<IconStarFilled size={10} class="mr-0.5 inline" />Recommended
              </span>
            {/if}
          </div>
          {#if featured.modelUrl}
            <a
              href={featured.modelUrl}
              download
              class="ml-auto inline-flex items-center gap-1.5 rounded bg-primary px-3 py-1.5 text-[13px] font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
            >
<IconDownload size={14} stroke={2} class="mr-1 inline" />Download weights
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
                    <IconStarFilled size={12} class="text-buzz" />

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

    <div class="flex flex-wrap items-center gap-3 rounded-xl border border-dark-4 bg-dark-7 px-4 py-3">
      <div class="flex flex-wrap gap-2">
        <Button size="sm" disabled={!publishTarget} onclick={openPublish}>
          Publish a model page
        </Button>
      </div>
      <p class="m-0 font-mono text-[11px] text-dark-2">
        {#if publishTarget}
          Uses the <IconStarFilled size={11} class="inline text-buzz" /> recommended checkpoint (epoch {publishTarget.number}) — opens on Civitai to name it,
          set visibility, and finish, where you can pick a different epoch.
        {:else}
          Available once a checkpoint with downloadable weights is ready.
        {/if}
      </p>
    </div>
  {/if}

  {#if d.dataset.length}
    <!-- Below the epochs — the results are the point; the dataset is a reference. Open while training (when
         there are no epochs yet), collapsed once finished; lazy images in a closed <details> don't load. -->
    <details open={d.state === 'training'} class="overflow-hidden rounded-xl border border-dark-4 bg-dark-6">
      <summary
        class="flex cursor-pointer select-none items-center gap-2 px-5 py-3 text-sm font-semibold text-dark-0 hover:bg-dark-5/40 [&::-webkit-details-marker]:hidden"
      >
        <IconPhoto size={16} stroke={2} class="text-dark-2" />
        Training data
        <span class="font-mono text-[11px] font-normal text-dark-2">
          {d.dataset.length} image{d.dataset.length === 1 ? '' : 's'}
        </span>
        <span class="ml-auto flex items-center gap-1.5">
          <button
            type="button"
            onclick={(e) => {
              e.preventDefault();
              reuseDataset();
            }}
            class="inline-flex items-center gap-1 rounded px-2 py-1 text-[12px] font-medium text-primary transition-colors hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            title="Start a new training with this dataset"
          >
            <IconRepeat size={13} stroke={2} />Train again
          </button>
          <button
            type="button"
            onclick={(e) => {
              e.preventDefault();
              void downloadDataset();
            }}
            disabled={downloading}
            class="inline-flex items-center gap-1 rounded px-2 py-1 text-[12px] font-medium text-dark-1 transition-colors hover:bg-dark-5 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50"
            title="Download images + captions as a .zip"
          >
            <IconArchive size={13} stroke={2} />{downloading ? 'Zipping…' : 'Download'}
          </button>
        </span>
      </summary>
      <div class="grid grid-cols-3 gap-3 border-t border-dark-4 p-5 sm:grid-cols-4 md:grid-cols-6">
        {#each d.dataset as item, i (item.air + i)}
          <figure class="m-0 flex flex-col gap-1">
            <img
              src={datasetSrc(item.air)}
              alt={item.caption || `dataset image ${i + 1}`}
              loading="lazy"
              class="aspect-square w-full rounded bg-dark-7 object-cover ring-1 ring-inset ring-dark-4/60"
            />
            {#if item.caption}
              <figcaption
                class="line-clamp-2 font-mono text-[10px] leading-snug text-dark-2"
                title={item.caption}
              >
                {item.caption}
              </figcaption>
            {/if}
          </figure>
        {/each}
      </div>
    </details>
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
