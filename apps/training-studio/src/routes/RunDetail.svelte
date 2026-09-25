<script lang="ts">
  import {
    backend,
    browser,
    generate,
    generateUrl,
    hostConfig,
    hostLink,
    hrefFor,
    modelPageUrl,
    navigate,
    portalProps,
    publishUrl,
  } from '$lib/host';
  import { loraBlobAir } from '$lib/train-core';
  import { debouncedQuote } from '$lib/debounced-quote.svelte';
  import { locationHref } from '$lib/actions/locationHref';
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
    IconBoltFilled,
    IconSparkles,
    IconUpload,
    IconExternalLink,
  } from '@tabler/icons-svelte';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import { ToggleGroup, ToggleGroupItem } from '@civitai/ui/components/ui/toggle-group/index.js';
  import { Toggle } from '@civitai/ui/components/ui/toggle/index.js';
  import TrainingTrace from '$lib/components/TrainingTrace.svelte';
  import RunStateBadge from '$lib/components/RunStateBadge.svelte';
  import SampleImage from '$lib/components/SampleImage.svelte';
  import SampleViewer from '$lib/components/SampleViewer.svelte';
  import {
    overallProgressPct,
    type TrainingDetail,
    type TrainingDetailEpoch,
  } from '$lib/data/trainingRows';
  import { directDatasetUrl, handoffReuse, toReuseItems } from '$lib/reuse';
  import { extOfAir, extOfMime } from '$lib/media';
  import { RETENTION_DAYS } from '$lib/orchestrator-core';
  import { nonBlueSpend } from '$lib/buzz-balance.svelte';
  import { buzzMode } from '$lib/buzz-mode.svelte';
  import * as Tooltip from '@civitai/ui/components/ui/tooltip/index.js';
  import * as Popover from '@civitai/ui/components/ui/popover/index.js';

  let {
    detail,
    onRefresh,
  }: {
    detail: TrainingDetail;
    /** Re-read the run from the host's data source (Kit load in the shell, a refetch in the element). */
    onRefresh: () => void | Promise<void>;
  } = $props();
  const d = $derived(detail);

  // Overall, monotonic training progress. The orchestrator's estimatedProgressRate is PER-EPOCH — it runs
  // 0→1 for the current epoch's job and restarts each epoch — so folding it into the count of finished
  // checkpoints gives a whole-run reading that climbs instead of resetting. Falls back to the raw rate, or
  // to finished/planned, when a piece is missing.
  const completedEpochs = $derived(d.epochs.length);
  const progressPct = $derived(overallProgressPct(completedEpochs, d.plannedEpochs, d.progress));
  // The epoch being trained now (one past the last finished checkpoint), capped at the plan. Labels
  // the live trace stream only — every progress COUNTER shows completed checkpoints, starting 0/N.
  const currentEpoch = $derived(
    d.plannedEpochs ? Math.min(completedEpochs + 1, d.plannedEpochs) : completedEpochs + 1
  );
  // "Train further" only makes sense once the run has finished all its epochs — continuing mid-run would
  // fork off a checkpoint that's still being superseded. `ready` (succeeded) or `published` are the terminal
  // success states; `training`/`failed` are not.
  const runComplete = $derived(d.state === 'ready' || d.state === 'published');
  // Missing samples read differently by run state: still training → the sample is being generated;
  // terminal (ready/published/failed) → it will never arrive.
  const samplesPending = $derived(d.state === 'training');

  // Live updates while training: re-read the run every few seconds so new epochs/samples stream in.
  // Each tick re-arms after the refetch settles — success or failure, so one bad refetch can't end
  // polling — and stops once the run leaves 'training' (this effect re-runs and the guard fails) or
  // the component unmounts.
  const POLL_MS = 5000;
  $effect(() => {
    if (!browser || d.state !== 'training') return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        await onRefresh();
      } catch {
        // transient refetch failure — keep polling
      }
      if (!stopped) timer = setTimeout(tick, POLL_MS);
    };
    timer = setTimeout(tick, POLL_MS);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
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
        void onRefresh();
    });
  });

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
      await backend().rename(d.workflowId, name);
      await onRefresh(); // re-read the title from the source
      renaming = false;
    } catch (err) {
      renameError = err instanceof Error ? err.message : 'Could not rename';
    } finally {
      saving = false;
    }
  }

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

  // When the run's data leaves the orchestrator: checkpoints and dataset are retained
  // RETENTION_DAYS from COMPLETION (the main app's stated policy), falling back to creation when
  // the step carries no completion date — that can only warn early, never late. Testers had no way
  // to tell whether a saved LoRA still existed — surface the date, and color it once it's a week out.
  const expiresAt = $derived(
    new Date(d.completedAt ?? d.createdAt).getTime() + RETENTION_DAYS * 86400000
  );
  const expiresLabel = $derived.by(() => {
    if (!Number.isFinite(expiresAt)) return '';
    const daysLeft = Math.ceil((expiresAt - Date.now()) / 86400000);
    if (daysLeft <= 0) return 'expired';
    const date = new Date(expiresAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    return `${date} (${daysLeft} day${daysLeft === 1 ? '' : 's'})`;
  });
  const expiresSoon = $derived(expiresAt - Date.now() < 7 * 86400000);

  // Wall-clock training time, from the step's own start/completion stamps. That pair is the only
  // duration the payload carries — epochs have no per-epoch timestamps in either output shape.
  const durationLabel = $derived.by(() => {
    if (!d.startedAt || !d.completedAt) return '';
    const min = Math.round((new Date(d.completedAt).getTime() - new Date(d.startedAt).getTime()) / 60000);
    if (min < 1) return '';
    return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`;
  });

  function formatBytes(bytes: number): string {
    if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
    if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
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

  // Newest checkpoint that actually has weights (a still-training run's newest epoch may have
  // samples but no downloadable model yet). Publish falls back to this when the selected epoch has
  // no weights; it also anchors "train further". (Generate is intentionally not here: creating a
  // throwaway draft model just to generate was rejected — the real fix is teaching the on-site
  // generator to accept a raw AIR/URL, done main-app-side.)
  const publishTarget = $derived(newestFirst.find((e) => e.modelUrl) ?? null);

  // Dataset blobs need auth to fetch (see StudioBackend.datasetBlob), so each one is resolved through
  // the seam into an object URL. Cached per air across polls — blobs are immutable per key — and
  // revoked on unmount. A failed fetch clears its slot so the next poll retries it.
  const datasetObjectUrls = new Map<string, string>();
  let datasetSrcs = $state<Record<string, string>>({});
  let destroyed = false;
  $effect(() => {
    if (!browser) return;
    const workflowId = d.workflowId;
    for (const item of d.dataset) {
      const air = item.air;
      if (directDatasetUrl(air) || datasetObjectUrls.has(air)) continue;
      datasetObjectUrls.set(air, '');
      backend()
        .datasetBlob(air, workflowId)
        .then((blob) => {
          if (destroyed) return;
          const url = URL.createObjectURL(blob);
          datasetObjectUrls.set(air, url);
          datasetSrcs = { ...datasetSrcs, [air]: url };
        })
        .catch(() => {
          datasetObjectUrls.delete(air);
        });
    }
  });
  $effect(() => () => {
    destroyed = true;
    for (const url of datasetObjectUrls.values()) if (url) URL.revokeObjectURL(url);
  });

  function datasetSrc(air: string): string | null {
    return directDatasetUrl(air) ?? datasetSrcs[air] ?? null;
  }

  // The blob's own extension (the air ends in one, e.g. `…-0.png`), falling back to the fetched
  // mime — both answered by $lib/media's one table, which the Data step's zip IMPORT reads too, so
  // a downloaded zip's names always round-trip.
  function fileExt(air: string, mime: string): string {
    const fromAir = extOfAir(air);
    if (fromAir && fromAir.length <= 4) return fromAir;
    return extOfMime(mime) ?? 'png';
  }
  function slug(s: string): string {
    return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'dataset';
  }

  async function fetchDatasetBlob(air: string): Promise<Blob> {
    const direct = directDatasetUrl(air);
    if (!direct) return backend().datasetBlob(air, d.workflowId);
    const res = await fetch(direct);
    if (!res.ok) throw new Error(String(res.status));
    return res.blob();
  }

  // Download the training data as a standard LoRA-layout zip: each image plus a same-named .txt caption,
  // so it round-trips with the Data step's "Import .zip" and works in other trainers.
  let downloading = $state(false);
  let downloadError = $state('');
  async function downloadDataset() {
    if (downloading || !d.dataset.length) return;
    downloading = true;
    downloadError = '';
    try {
      const zip = new JSZip();
      const pad = Math.max(2, String(d.dataset.length).length);
      let fetched = 0;
      await Promise.all(
        d.dataset.map(async (item, i) => {
          let blob: Blob;
          try {
            blob = await fetchDatasetBlob(item.air);
          } catch {
            return;
          }
          fetched += 1;
          const base = String(i + 1).padStart(pad, '0');
          zip.file(`${base}.${fileExt(item.air, blob.type)}`, blob);
          if (item.caption.trim()) zip.file(`${base}.txt`, item.caption.trim());
        })
      );
      // An all-skips zip would download EMPTY and read as success.
      if (fetched === 0) {
        downloadError = "Couldn't fetch the dataset images — nothing to download.";
        return;
      }
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

  // Reuse this run's already-scanned dataset blobs as-is (no re-upload) to seed a new training.
  async function reuseDataset() {
    handoffReuse(await toReuseItems(d.dataset, d.workflowId));
  }

  // Only an explicit host `false` gates — absent means the host has no membership knowledge and
  // the affordance behaves as before (see HostContext.config.canGenerateUnpublished). A function,
  // not $derived: the host context isn't reactive, so a frozen derived would never see a re-wired
  // config — read it at render time like the generate()/generateUrl() seam reads.
  const generateGated = () => hostConfig().canGenerateUnpublished === false;

  // "Generate with this epoch": the handoff for a checkpoint's weights blob. A host `generate`
  // opens its generator in place (button); otherwise `generateUrl` gives a /generate deep link
  // (`hostLink` decides same-tab vs new-tab). Null hides the affordance — neither callback from
  // the host, no ecosystem to scope the AIR by, or no downloadable weights yet.
  function epochGenerateLink(
    epoch: TrainingDetailEpoch
  ): { action: () => void } | ReturnType<typeof hostLink> | null {
    if (!d.ecosystem || !epoch.modelKey) return null;
    const req = {
      air: loraBlobAir(d.ecosystem, epoch.modelKey),
      workflowId: d.workflowId,
      name: `${d.name} · epoch ${epoch.number}`,
    };
    const inPlace = generate();
    if (inPlace) return { action: () => inPlace(req) };
    const toUrl = generateUrl();
    if (!toUrl) return null;
    return hostLink(toUrl(req));
  }

  let furtherEpochs = $state(5);
  let confirming = $state(false);
  let continuing = $state(false);
  let continueError = $state('');
  let quoteError = $state('');

  // Primitive keys for the quote/ancestor derivations: `detail` (and so `d` and `publishTarget`) gets
  // a NEW identity on every poll/rename refresh, so keying on those objects would re-issue a quote —
  // or re-fetch the ancestor chain — each tick even when nothing they depend on changed.
  const workflowIdKey = $derived(d.workflowId);
  const quoteFromEpoch = $derived(publishTarget?.number ?? null);
  const lineageParentId = $derived(d.sourceWorkflowId ?? null);

  // Combined epochs: opt-in load of the "train further" ancestor chain, rendered read-only in the
  // compare grid. Only continuations submitted after lineage shipped carry the metadata.
  let showLineage = $state(false);
  // Bumped by the {:catch} Retry — part of the derived expression, so the promise rebuilds.
  let lineageVersion = $state(0);
  const ancestors = $derived.by(() => {
    if (!browser || !showLineage || !lineageParentId) return null;
    void lineageVersion;
    return loadAncestorChain(workflowIdKey, lineageParentId);
  });

  async function loadAncestorChain(selfId: string, firstParent: string): Promise<TrainingDetail[]> {
    // Depth cap + cycle guard — the chain lives in workflow metadata, which is user-space data.
    const seen = new Set([selfId]);
    const chain: TrainingDetail[] = [];
    let next: string | undefined = firstParent;
    while (next && !seen.has(next) && chain.length < 5) {
      seen.add(next);
      const anc = await backend().getRunDetail(next);
      chain.push(anc);
      next = anc.sourceWorkflowId;
    }
    return chain;
  }

  // Re-quote when the epoch count changes so the confirm always shows the current price;
  // debounce/blank/latest-wins live in `debouncedQuote`. The fetcher owns the error string.
  // The key runs inside a $derived, so it must stay pure — the inactive-clears-error rule
  // lives in the effect below instead.
  const continueQuoteKey = $derived.by(() => {
    const epochs = Number(furtherEpochs) || 0;
    if (!browser || !runComplete || quoteFromEpoch === null || epochs < 1) return null;
    return `${workflowIdKey}#${quoteFromEpoch}#${epochs}`;
  });
  $effect(() => {
    // A stale "could not price" must not linger after the panel closes or the input empties.
    if (continueQuoteKey === null) quoteError = '';
  });
  const continueQuoteState = debouncedQuote(
    () => continueQuoteKey,
    async () => {
      try {
        const q = await backend().continueQuote(
          workflowIdKey,
          quoteFromEpoch!,
          Number(furtherEpochs) || 0
        );
        quoteError = '';
        return {
          cost: q.cost,
          eta: q.steps ? Math.max(1, Math.round((q.steps / 2000) * 18)) : null,
        };
      } catch (err) {
        quoteError = err instanceof Error ? err.message : 'Could not price this';
        return null;
      }
    }
  );
  const quote = $derived(continueQuoteState.value ?? null);

  async function doTrainFurther() {
    // Never submit without a shown price — the confirm cost the user sees must be the one that gets charged.
    if (!publishTarget || continuing || quote == null) return;
    continuing = true;
    continueError = '';
    try {
      const id = await backend().continueRun(
        d.workflowId,
        publishTarget.number,
        Number(furtherEpochs) || 5
      );
      await navigate({ view: 'run', workflowId: id });
    } catch (err) {
      continueError = err instanceof Error ? err.message : 'Could not start training';
      confirming = false;
    } finally {
      continuing = false;
    }
  }


  // The user's chosen checkpoint drives the featured view. `null` follows the recommended one. Resolving
  // the id against the CURRENT run's epochs means a stale id carried across a /[id]→/[id] navigation just
  // falls back to recommended — no reseed needed.
  let selectedId = $state<string | null>(null);
  const featured = $derived(newestFirst.find((e) => e.id === selectedId) ?? recommended);

  const publishEpoch = $derived(featured?.modelUrl ? featured : publishTarget);
  const publishLink = $derived.by(() => {
    const toUrl = publishUrl();
    if (!toUrl || !publishEpoch) return null;
    return hostLink(toUrl({ workflowId: d.workflowId, epoch: publishEpoch.number }));
  });

  // Independent of `publishTarget` so the link outlives the checkpoints' blob retention.
  const modelLink = $derived.by(() => {
    const toUrl = modelPageUrl();
    if (!toUrl || d.modelId == null) return null;
    return hostLink(toUrl({ modelId: d.modelId }));
  });

  let mode = $state<'epoch' | 'compare'>('epoch');
  // A single-epoch continuation still has ancestors worth comparing against, so lineage alone
  // unlocks the compare view.
  const canCompare = $derived(newestFirst.length > 1 || Boolean(d.sourceWorkflowId));
  const showCompare = $derived(mode === 'compare' && canCompare);

  // The fullscreen viewer navigates over `newestFirst` (↑ = newer epoch, matching the in-app trainer).
  let viewer = $state<{ epochIndex: number; sampleIndex: number } | null>(null);
  function openViewer(epoch: TrainingDetailEpoch, sampleIndex: number) {
    // Audio samples are inline players (the controls are the interaction) — no fullscreen viewer.
    if (d.media === 'audio') return;
    const epochIndex = newestFirst.indexOf(epoch);
    if (epochIndex !== -1) viewer = { epochIndex, sampleIndex };
  }

  // A param-only /[id]→/[id'] navigation reuses this component — and Train-further's own goto lands on
  // exactly such a navigation — so per-run UI state must not ride onto the new subject: an open confirm, a
  // stale price/error, or a viewer index into the previous run's epochs. Keyed on `workflowIdKey`, NOT
  // `d.workflowId`: reading through `d` re-runs this on every poll refresh (new object identity), which
  // reset all of this state every 5s while training.
  $effect(() => {
    void workflowIdKey;
    viewer = null;
    confirming = false;
    continueError = '';
    // The quote itself blanks via debouncedQuote (workflowIdKey is part of its key).
    quoteError = '';
    downloadError = '';
    showLineage = false;
  });
</script>

<!-- The one place the Generate affordance decides gated vs in-place action vs deep link — a render
     site that skipped the gate would silently un-gate non-members. When the host says this user
     can't use unpublished weights, clicking the muted button (touch and keyboard included — a
     tooltip's content is unreachable for both) explains the gate instead of silently doing nothing. -->
{#snippet epochGenerate(
  gen: { action: () => void } | ReturnType<typeof hostLink>,
  liveCls: string,
  gatedCls: string,
  iconSize: number,
  title: string | undefined = undefined
)}
  {#if generateGated()}
    {@const pricing = hostConfig().pricingUrl}
    <Popover.Root>
      <!-- Not aria-disabled: the control is live — it opens the explanation. -->
      <Popover.Trigger class="{gatedCls} cursor-not-allowed text-dark-2">
        <IconSparkles size={iconSize} stroke={2} />Generate
      </Popover.Trigger>
      <Popover.Content class="max-w-[260px] text-xs" portalProps={portalProps()}>
        Generating with unpublished training results requires a Civitai membership.
        {#if pricing}
          <a {...hostLink(pricing)} class="font-semibold text-primary hover:underline">View plans</a>
        {/if}
      </Popover.Content>
    </Popover.Root>
  {:else if 'action' in gen}
    <button type="button" onclick={gen.action} {title} class={liveCls}>
      <IconSparkles size={iconSize} stroke={2} />Generate
    </button>
  {:else}
    <a {...gen} {title} class={liveCls}>
      <IconSparkles size={iconSize} stroke={2} />Generate
    </a>
  {/if}
{/snippet}

<section class="flex flex-col gap-6">
  <a href={hrefFor({ view: 'home' })} use:locationHref={{ view: 'home' }} class="inline-flex items-center gap-1 font-mono text-xs text-dark-2 transition-colors hover:text-white">
    <IconArrowLeft size={13} stroke={2} />My trainings
  </a>

  <header class="rounded-xl border border-dark-4 bg-dark-6 p-5">
    <div class="flex flex-wrap items-start gap-4">
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
            <p class="mt-1 font-mono text-xs text-red-400">{renameError}</p>
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
        {#if d.sourceWorkflowId && d.sourceEpoch != null}
          <p class="mb-0 mt-1 flex items-center gap-1 text-[12px] text-dark-2">
            <IconRepeat size={12} stroke={2} class="shrink-0" />
            Continued from epoch {d.sourceEpoch} of
            <a
              href={hrefFor({ view: 'run', workflowId: d.sourceWorkflowId })}
              use:locationHref={{ view: 'run', workflowId: d.sourceWorkflowId }}
              class="max-w-[14ch] truncate font-mono text-primary hover:underline"
              title={d.sourceWorkflowId}
            >
              {d.sourceWorkflowId}
            </a>
          </p>
        {/if}
      </div>
      <RunStateBadge state={d.state} />
    </div>

    <dl class="mt-4 flex flex-wrap gap-x-8 gap-y-2 border-t border-dark-4 pt-4 font-mono text-xs">
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
      {#if durationLabel}
        <div class="flex items-center gap-1.5">
          <dt class="text-dark-2">Trained in</dt>
          <dd class="m-0 text-dark-0">{durationLabel}</dd>
        </div>
      {/if}
      {#if d.state !== 'training' && d.epochs.length > 0 && expiresLabel}
        <div class="flex items-center gap-1.5">
          <dt class="text-dark-2">Expires</dt>
          <dd class="m-0 {expiresSoon ? 'text-buzz' : 'text-dark-0'}">
            <Tooltip.Provider>
              <Tooltip.Root>
                <Tooltip.Trigger class="cursor-default">{expiresLabel}</Tooltip.Trigger>
                <Tooltip.Content class="max-w-[240px] text-xs" portalProps={portalProps()}>
                  Download or publish anything you want to keep.
                </Tooltip.Content>
              </Tooltip.Root>
            </Tooltip.Provider>
          </dd>
        </div>
      {/if}
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
          {progressPct}%{#if d.plannedEpochs} · checkpoint {completedEpochs} / {d.plannedEpochs}{/if}
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
      <TrainingTrace traceUrl={d.liveTraceUrl} plannedEpochs={d.plannedEpochs ?? null} {currentEpoch} />
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
      {#if d.dataset.length}
        <Button class="mt-4" variant="outline" onclick={reuseDataset}>
          <IconRepeat size={14} stroke={2} class="mr-1.5 inline" />Try again with this dataset
        </Button>
      {/if}
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
    {#if canCompare}
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
      {#snippet compareGrid(ancestorRuns: TrainingDetail[])}
        <!-- Ancestor columns render oldest run first so the whole grid reads as one evolution
             left→right; each run's epoch numbers restart at 1, so the run name disambiguates. -->
        {@const ancestorCols = [...ancestorRuns]
          .reverse()
          .flatMap((run) =>
            [...run.epochs]
              .sort((a, b) => a.number - b.number)
              .map((epoch) => ({ run, epoch }))
          )}
        {#if ancestorRuns.length && ancestorCols.length === 0}
          <p class="mb-3 font-mono text-xs text-dark-2">
            No checkpoints in the earlier runs — showing this run only.
          </p>
        {/if}
        <div class="overflow-x-auto">
          <div
            class="grid gap-2"
            style="grid-template-columns: minmax(150px, 190px) repeat({ancestorCols.length +
              oldestFirst.length}, 116px)"
          >
            <div></div>
            {#each ancestorCols as col (`${col.run.workflowId}:${col.epoch.id}`)}
              <div
                class="flex items-center justify-center rounded border border-dashed border-dark-4 px-1.5 py-1 text-center text-xs font-semibold leading-tight text-dark-2"
                title="Epoch {col.epoch.number} of {col.run.name}"
              >
                <span class="truncate">epoch {col.epoch.number} · {col.run.name}</span>
              </div>
            {/each}
            {#each oldestFirst as epoch (epoch.id)}
              <button
                type="button"
                onclick={() => {
                  selectedId = epoch.id;
                  mode = 'epoch';
                }}
                class="flex items-center justify-center gap-1 rounded border px-1.5 py-1 text-xs font-semibold transition-colors {epoch ===
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
                class="flex items-center pr-2 text-xs leading-relaxed text-dark-2"
                title={prompt}
              >
                <span class="line-clamp-4">{prompt}</span>
              </div>
              {#each ancestorCols as col (`${col.run.workflowId}:${col.epoch.id}`)}
                <!-- Beyond the ancestor's own slot count, "sample failed" would assert a failure for a
                     sample that run was never asked to generate — stay neutral there. -->
                <SampleImage
                  isVideo={col.run.isVideo}
                  isAudio={col.run.media === 'audio'}
                  url={col.epoch.samples[r] ?? null}
                  pending={r < col.epoch.samples.length ? col.run.state === 'training' : null}
                  alt="Epoch {col.epoch.number} of {col.run.name}, prompt {r + 1}"
                  class="opacity-80"
                />
              {/each}
              {#each oldestFirst as epoch (epoch.id)}
                {@const cellUrl = epoch.samples[r] ?? null}
                {#if cellUrl}
                  <button
                    type="button"
                    onclick={() => openViewer(epoch, r)}
                    class="block w-full cursor-zoom-in rounded transition hover:ring-2 hover:ring-primary/50"
                    aria-label="Open Epoch {epoch.number}, prompt {r + 1}"
                  >
                    <SampleImage isVideo={d.isVideo} isAudio={d.media === 'audio'} url={cellUrl} alt="Epoch {epoch.number}, prompt {r + 1}" />
                  </button>
                {:else}
                  <SampleImage isVideo={d.isVideo} isAudio={d.media === 'audio'} url={null} pending={samplesPending} />
                {/if}
              {/each}
            {/each}
          </div>
        </div>
      {/snippet}
      <div class="rounded-xl border border-dark-4 bg-dark-6 p-5">
        <div class="mb-4 flex flex-wrap items-center gap-3">
          <p class="m-0 text-xs text-dark-2">
            Each prompt across every checkpoint — scan a row to see how a sample evolved. Click a checkpoint
            to open and download it.
          </p>
          {#if d.sourceWorkflowId}
            <Toggle
              bind:pressed={() => showLineage, (v) => (showLineage = v)}
              variant="outline"
              size="sm"
              class="ml-auto text-xs"
            >
              <IconRepeat size={12} stroke={2} />{showLineage ? 'Hide earlier runs' : 'Include earlier runs'}
            </Toggle>
          {/if}
        </div>
        {#if ancestors}
          {#await ancestors}
            {@render compareGrid([])}
            <p class="mt-3 font-mono text-xs text-dark-2">Loading earlier runs…</p>
          {:then chain}
            {@render compareGrid(chain)}
          {:catch err}
            {@render compareGrid([])}
            <p class="mt-3 flex items-center gap-2 font-mono text-xs text-red-400">
              Couldn't load earlier runs: {err instanceof Error ? err.message : String(err)}
              <Button variant="outline" size="sm" onclick={() => (lineageVersion += 1)}>Retry</Button>
            </p>
          {/await}
        {:else}
          {@render compareGrid([])}
        {/if}
      </div>
    {:else if featured}
      <div class="rounded-xl border border-dark-4 bg-dark-6 p-5">
        <div class="mb-4 flex flex-wrap items-center gap-3">
          <div class="flex items-baseline gap-2">
            <h2 class="m-0 text-lg font-semibold text-white">Epoch {featured.number}</h2>
            {#if featured === recommended}
              <Tooltip.Provider>
                <Tooltip.Root>
                  <Tooltip.Trigger
                    class="cursor-default rounded bg-buzz/15 px-2 py-0.5 text-xs font-semibold text-buzz"
                  >
                    <IconStarFilled size={10} class="mr-0.5 inline" />Recommended
                  </Tooltip.Trigger>
                  <Tooltip.Content class="max-w-[280px] text-xs" portalProps={portalProps()}>
                    This epoch has had the most training time applied to it and, in most cases, is
                    the best choice. Models made with smaller datasets may overbake at high training
                    time, so a lower epoch can be better.
                  </Tooltip.Content>
                </Tooltip.Root>
              </Tooltip.Provider>
            {/if}
          </div>
          {#if featured.modelUrl}
            {@const gen = epochGenerateLink(featured)}
            <div class="ml-auto flex flex-wrap items-center gap-2">
              {#if gen}
                {@render epochGenerate(
                  gen,
                  'inline-flex items-center gap-1.5 rounded border border-primary/40 px-3 py-1.5 text-[13px] font-semibold text-primary transition-colors hover:bg-primary/10',
                  'inline-flex items-center gap-1.5 rounded border border-dark-4 px-3 py-1.5 text-[13px] font-semibold',
                  14
                )}
              {/if}
              <a
                href={featured.modelUrl}
                download
                class="inline-flex items-center gap-1.5 rounded bg-primary px-3 py-1.5 text-[13px] font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
              >
<IconDownload size={14} stroke={2} class="mr-1 inline" />Download weights
              </a>
            </div>
          {:else}
            <span
              class="ml-auto rounded border border-dark-4 px-3 py-1.5 font-mono text-xs text-dark-2"
            >
              Weights not ready
            </span>
          {/if}
        </div>

        <div class="grid grid-cols-1 gap-4 {d.media === 'audio' ? '' : 'sm:grid-cols-3'}">
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
                  <SampleImage isVideo={d.isVideo} isAudio={d.media === 'audio'} url={featuredUrl} alt="Epoch {featured.number} sample {i + 1}" />
                </button>
              {:else}
                <SampleImage isVideo={d.isVideo} isAudio={d.media === 'audio'} url={null} pending={samplesPending} />
              {/if}
              <figcaption class="text-xs leading-relaxed text-dark-2" title={prompt}>
                {prompt}
              </figcaption>
            </figure>
          {/each}
        </div>

        <!-- Only what the payload actually carries: legacy runs stamp a weights size; ai-toolkit
             epochs carry no size and no per-epoch timestamps, so this hides rather than guess. -->
        {#if featured.sizeBytes != null}
          <details class="mt-4 self-start">
            <summary
              class="cursor-pointer select-none font-mono text-xs text-dark-2 transition-colors hover:text-dark-0"
            >
              More about this epoch
            </summary>
            <dl class="mt-2 flex flex-wrap gap-x-8 gap-y-1 rounded-md border border-dark-4 bg-dark-7 px-3 py-2 font-mono text-xs">
              <div class="flex items-center gap-1.5">
                <dt class="text-dark-2">Weights file size</dt>
                <dd class="m-0 text-dark-0">{formatBytes(featured.sizeBytes)}</dd>
              </div>
            </dl>
          </details>
        {/if}
      </div>

      {#if newestFirst.length > 1}
        <div>
          <h3 class="mb-3 text-sm font-semibold text-dark-0">
            Checkpoints
            <span class="ml-1 font-mono text-xs font-normal text-dark-2">
              pick one to preview and download
            </span>
          </h3>
          <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {#each newestFirst as epoch (epoch.id)}
              {@const isSelected = epoch === featured}
              {@const gen = epochGenerateLink(epoch)}
              <!-- The whole card is the select button, so the per-epoch Generate link can't nest
                   inside it — it overlays the header's right slot from a relative wrapper. -->
              <div class="relative">
                <button
                  type="button"
                  onclick={() => (selectedId = epoch.id)}
                  aria-pressed={isSelected}
                  class="h-full w-full rounded-md border p-3 text-left transition-colors {isSelected
                    ? 'border-primary bg-primary/5 ring-1 ring-primary/40'
                    : 'border-dark-4 bg-dark-7 hover:border-dark-3'}"
                >
                  <div class="mb-2.5 flex items-center gap-2">
                    <span class="text-sm font-bold text-dark-0">Epoch {epoch.number}</span>
                    {#if epoch === recommended}
                      <IconStarFilled size={12} class="text-buzz" />

                    {/if}
                    {#if !gen}
                      <span class="ml-auto font-mono text-xs text-dark-2">
                        {epoch.modelUrl ? 'weights ready' : 'no weights'}
                      </span>
                    {/if}
                  </div>
                  <div class="grid grid-cols-3 gap-1.5">
                    {#each promptLabels as _, si (si)}
                      <SampleImage
                        isVideo={d.isVideo} isAudio={d.media === 'audio'}
                        url={epoch.samples[si] ?? null}
                        pending={samplesPending}
                        alt="Epoch {epoch.number} preview {si + 1}"
                      />
                    {/each}
                  </div>
                </button>
                {#if gen}
                  <span class="absolute right-2 top-2">
                    {@render epochGenerate(
                      gen,
                      'inline-flex items-center gap-1 rounded px-1.5 py-1 text-xs font-medium text-primary transition-colors hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
                      'inline-flex items-center gap-1 rounded px-1.5 py-1 text-xs font-medium',
                      12,
                      `Generate with epoch ${epoch.number}`
                    )}
                  </span>
                {/if}
              </div>
            {/each}
          </div>
        </div>
      {/if}
    {/if}

    {#if publishTarget && runComplete}
      <div id="train-further" class="rounded-xl border border-dark-4 bg-dark-6 p-5">
        <div class="flex flex-wrap items-center gap-3">
          <div class="min-w-0">
            <h3 class="m-0 flex items-center gap-1.5 text-base font-semibold text-white">
              <IconRepeat size={16} stroke={2} class="text-dark-2" />Train further
            </h3>
            <p class="mt-1 text-[13px] text-dark-2">
              Don't love the progression yet? Continue from the
              <IconStarFilled size={11} class="inline text-buzz" /> recommended checkpoint (epoch {publishTarget.number})
              with more training — same dataset and settings, starts a new run. Each checkpoint is a
              save point along the way, not one pass over your images.
            </p>
          </div>
          <div class="ml-auto flex flex-col items-end gap-1.5">
            <div class="flex items-center gap-2">
              <label for="further-epochs" class="font-mono text-xs text-dark-2">+ checkpoints</label>
              <Input
                id="further-epochs"
                type="number"
                min={1}
                max={20}
                bind:value={furtherEpochs}
                disabled={confirming || continuing}
                class="w-20"
              />
              {#if confirming}
                <Button onclick={doTrainFurther} disabled={continuing || quote == null}>
                  {#if continuing}Starting…{:else}Confirm{#if quote?.cost != null}
                      <span class="ml-1 inline-flex items-center"
                        >— <IconBoltFilled size={13} stroke={2} class="mx-0.5 inline" />{quote.cost.toLocaleString()}</span
                      >{/if}{/if}
                </Button>
                <Button variant="outline" onclick={() => (confirming = false)} disabled={continuing}>
                  Cancel
                </Button>
              {:else}
                <Button onclick={() => (confirming = true)}>Train further</Button>
              {/if}
            </div>
            <div class="font-mono text-xs text-dark-2">
              {#if quoteError}
                <span class="text-red-400">{quoteError}</span>
              {:else if quote?.cost != null}
                {@const spend = nonBlueSpend(quote.cost, buzzMode.value)}
                Costs <span class="text-buzz"
                  ><IconBoltFilled size={10} stroke={2} class="mb-px inline" />{quote.cost.toLocaleString()}</span
                >{#if quote.eta} · ~{quote.eta} min{/if} · spends Buzz on confirm{#if spend}
                  · <span class="text-buzz"
                    >{spend.amount.toLocaleString()}
                    {spend.uncertain ? 'may come' : ''} from {spend.currency === 'green'
                      ? 'Green'
                      : 'Yellow'}</span
                  >{/if}
              {:else}
                pricing…
              {/if}
            </div>
          </div>
        </div>
        {#if continueError}
          <p class="mt-2 font-mono text-xs text-red-400">{continueError}</p>
        {/if}
      </div>
    {/if}

    {#if publishUrl() || modelLink}
      <div class="flex flex-wrap items-center gap-3 rounded-xl border border-dark-4 bg-dark-6 p-5">
        {#if d.state === 'published'}
          <!-- State first, link second: a published run must never fall through to a Publish CTA —
               older runs carry `published` without `modelId`, and a host may omit modelPageUrl. -->
          {#if modelLink}
            <Button size="sm" {...modelLink}>
              <IconExternalLink size={14} stroke={2} />View your model page
            </Button>
          {/if}
          <p class="m-0 font-mono text-xs text-dark-2">
            This run was published as a model on Civitai.
          </p>
        {:else if publishLink && publishEpoch}
          <Button size="sm" {...publishLink}>
            <IconUpload size={14} stroke={2} />Publish a model page
          </Button>
          {#if modelLink}
            <Button size="sm" variant="outline" {...modelLink}>
              <IconExternalLink size={14} stroke={2} />View draft
            </Button>
            <p class="m-0 font-mono text-xs text-dark-2">
              You already have a draft model page for this run — publishing picks up where you left
              off, or open the draft directly.
            </p>
          {:else}
            <p class="m-0 font-mono text-xs text-dark-2">
              Creates a draft model page on Civitai from epoch {publishEpoch.number}{publishEpoch ===
              recommended
                ? ' (recommended)'
                : ''} — you review, finish, and publish it there. Nothing goes public until you do.
            </p>
          {/if}
        {:else if modelLink}
          <!-- A draft exists but there's nothing to publish from here — the weights expired, or
               this host has no publish surface. The draft link must not hide behind either. -->
          <Button size="sm" variant="outline" {...modelLink}>
            <IconExternalLink size={14} stroke={2} />View draft
          </Button>
          <p class="m-0 font-mono text-xs text-dark-2">
            You have a draft model page for this run on Civitai.
          </p>
        {:else}
          <Button size="sm" disabled>Publish a model page</Button>
          <p class="m-0 font-mono text-xs text-dark-2">
            Available once a checkpoint with downloadable weights is ready.
          </p>
        {/if}
      </div>
    {/if}
  {/if}

  {#if d.dataset.length}
    <!-- Below the epochs — the results are the point; the dataset is a reference. Open while training (when
         there are no epochs yet), collapsed once finished. -->
    <details open={d.state === 'training'} class="overflow-hidden rounded-xl border border-dark-4 bg-dark-6">
      <summary
        class="flex cursor-pointer select-none items-center gap-2 px-5 py-3 text-sm font-semibold text-dark-0 hover:bg-dark-5/40 [&::-webkit-details-marker]:hidden"
      >
        <IconPhoto size={16} stroke={2} class="text-dark-2" />
        Training data
        <span class="font-mono text-xs font-normal text-dark-2">
          {d.dataset.length} image{d.dataset.length === 1 ? '' : 's'}
        </span>
        <span class="ml-auto flex items-center gap-1.5">
          <button
            type="button"
            onclick={(e) => {
              e.preventDefault();
              void reuseDataset();
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
          {#if downloadError}
            <span class="font-mono text-xs text-red-400">{downloadError}</span>
          {/if}
        </span>
      </summary>
      <div class="grid grid-cols-3 gap-3 border-t border-dark-4 p-5 sm:grid-cols-4 md:grid-cols-6">
        {#each d.dataset as item, i (item.air + i)}
          {@const src = datasetSrc(item.air)}
          <figure class="m-0 flex flex-col gap-1">
            {#if src}
              <img
                src={src}
                alt={item.caption || `dataset image ${i + 1}`}
                class="aspect-square w-full rounded bg-dark-7 object-cover ring-1 ring-inset ring-dark-4/60"
              />
            {:else}
              <div class="aspect-square w-full rounded bg-dark-7 ring-1 ring-inset ring-dark-4/60"></div>
            {/if}
            {#if item.caption}
              <figcaption
                class="line-clamp-2 font-mono text-xs leading-snug text-dark-2"
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
