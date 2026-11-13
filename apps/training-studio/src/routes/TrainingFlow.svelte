<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { IconCheck, IconArrowLeft } from '@tabler/icons-svelte';
  import { backend, navigate } from '$lib/host';
  import { isMatureNsfwLevel } from '$lib/buzz-balance.svelte';
  import { submitNotice } from '$lib/submit-notice.svelte';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import SelectStep from './SelectStep.svelte';
  import DataStep from './DataStep.svelte';
  import EditDataStep from './EditDataStep.svelte';
  import ReviewStep from './ReviewStep.svelte';
  import ServiceStatusBanner from '$lib/components/ServiceStatusBanner.svelte';
  import {
    buildTrainingRuns,
    stampMature,
    defaultRunParams,
    isTrainable,
    labelOptions,
    labelString,
    runCard,
    runParamsKey,
    runTrainsPairs,
    seedPrompts,
    type DatasetFilter,
    type Img,
    type LaunchedRun,
    type RunParams,
    type SamplePrompt,
    type Selection,
  } from './trainingFlow';
  import type { FromPrices, LabelType } from '$lib/data/trainingModels';
  import { isPairDataset, type ReuseItem } from '$lib/reuse';
  import { isPairReady, pairImgs, pairItems, seedEditPrompts, type EditPair } from './editPairs';
  import { JUNK_TAGS } from '$lib/autolabel-exclude';
  import type { TrainingRunPayload } from '$lib/backend';
  import { newSubmitKey } from '$lib/submit-key';
  import { watchReadiness, type ReadinessView } from './uploadReadiness';

  let {
    prices,
    enabledModelFlags = [],
    onExit,
  }: { prices: FromPrices; enabledModelFlags?: string[]; onExit: () => void } = $props();

  const STEPS = [
    { n: 1, label: 'Select' },
    { n: 2, label: 'Data & labels' },
    { n: 3, label: 'Review & start' },
  ] as const;

  let step = $state(1);
  let dataFilter = $state<DatasetFilter>('all');
  let selection = $state<Selection | null>(null);
  // Dataset + trigger + label mode are owned here so they survive Back/Continue between steps. `labelMode`
  // defaults to the chosen model's default label and is only user-changeable for a `bothLabels` model.
  let images = $state<Img[]>([]);
  // An edit LoRA's dataset: before/after pairs instead of `images`. Kept apart so switching model
  // type on Select never mixes the two.
  let pairs = $state<EditPair[]>([]);
  let trigger = $state('');
  let labelMode = $state<LabelType>('tag');
  // Auto-label behavior, owned here like labelMode/trigger so it survives Back/Continue:
  // 'auto' labels each upload batch as it settles (the historical behavior); 'manual' waits for the
  // explicit Auto-label button. `excludeTags` are never applied by auto-label results (tag mode).
  let autoLabel = $state<'auto' | 'manual'>('auto');
  let excludeTags = $state<string[]>([...JUNK_TAGS]);
  let excludeCharacter = $state(true);
  let excludeSource = $state(true);
  // Review-step fields, owned here for the same reason. Name and prompts remember what they were seeded
  // from: while unedited they follow a changed trigger / dataset, once edited they're kept. Empty
  // `samplePrompts` means unseeded — Review never lets the list reach zero.
  let reviewName = $state('');
  let reviewNameSeed: string | null = null;
  let samplePrompts = $state<SamplePrompt[]>([]);
  let promptsSeed: { labels: string; prompts: string } | null = null;
  let runParams = $state<Record<string, RunParams>>({});
  // The trigger and LoRA type the current Review params were seeded with.
  let paramsSeedTrigger = '';
  let paramsSeedLoraType = '';
  let presetType = $state('');
  let openAdvanced = $state('');
  let acknowledgedAdvanced = $state<Record<string, boolean>>({});

  // A "Train again with this data" hand-off from a run's detail page: reuse its blob airs (already
  // uploaded + scanned) rather than re-uploading. Read once, then cleared so a refresh doesn't re-import.
  // DataStep materializes these once a model is picked (the label type depends on the selection).
  let reuseItems = $state<ReuseItem[]>([]);
  // An edit run's hand-off: EditDataStep turns it into pairs once, then empties it.
  let reusePairItems = $state<ReuseItem[]>([]);
  onMount(() => {
    try {
      const raw = sessionStorage.getItem('ts:reuse-dataset');
      if (raw) {
        const items: ReuseItem[] = JSON.parse(raw);
        if (isPairDataset(items)) reusePairItems = items;
        else reuseItems = items;
        sessionStorage.removeItem('ts:reuse-dataset');
      }
    } catch {
      // Malformed hand-off — ignore and start empty.
    }
  });
  const trainsPairs = $derived(!!selection && runTrainsPairs(selection.runs[0]!));
  const readyPairs = $derived(pairs.filter(isPairReady));
  // The plain Data step's trigger word, unless this is an edit run: that step never shows one, so a word
  // typed before switching to an edit model must not ride along.
  const runTrigger = $derived(trainsPairs ? '' : trigger);
  // Only successfully uploaded + scanned images train — blocked / in-flight tiles don't count.
  const trainableCount = $derived(
    trainsPairs ? readyPairs.length : images.filter(isTrainable).length
  );
  const matureCount = $derived(
    trainsPairs
      ? readyPairs.filter(
          (p) => isMatureNsfwLevel(p.before.nsfwLevel) || isMatureNsfwLevel(p.after?.nsfwLevel)
        ).length
      : images.filter((i) => isTrainable(i) && isMatureNsfwLevel(i.nsfwLevel)).length
  );

  // The blobs the submit sends (buildTrainingRuns / pairItems), keyed order-free.
  const datasetBlobIds = $derived(
    trainsPairs
      ? pairItems(pairs).map((i) => i.air)
      : images.filter((i) => i.status === 'uploaded' && !!i.blobId).map((i) => i.blobId!)
  );
  const datasetKey = $derived([...datasetBlobIds].sort().join('\n'));
  // The server's count under the v2 rating, for the dataset it was made for. Until it answers, or when
  // the rating is off for this user, Review counts from the upload rating as before.
  let ratedMature = $state<{ key: string; count: number } | null>(null);
  const RATING_POLLS = 6;
  const RATING_POLL_MS = 5000;
  $effect(() => {
    // After the readiness wait, so Review never reads every file for both at once.
    if (step !== 3 || !readinessSettled) return;
    const be = backend();
    if (!be.datasetRating) return;
    const ids = datasetBlobIds;
    const key = datasetKey;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ask = async (poll: number) => {
      try {
        const res = await be.datasetRating!(ids);
        if (stopped || !res.enabled) return;
        ratedMature = { key, count: res.matureCount };
        if (res.unrated > 0 && poll < RATING_POLLS)
          timer = setTimeout(() => void ask(poll + 1), RATING_POLL_MS);
      } catch {
        // the upload rating's count stands
      }
    };
    void ask(1);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  });
  const reviewMatureCount = $derived(
    ratedMature?.key === datasetKey ? ratedMature.count : matureCount
  );

  // Review holds Start until the orchestrator would take every dataset file, for the dataset it was made for.
  let readiness = $state<{ key: string; view: ReadinessView } | null>(null);
  // "Check again" bumps this to start a fresh wait.
  let readinessRound = $state(0);
  const readinessSupported = !!backend().datasetReadiness && !!backend().datasetReadyToTrain;
  $effect(() => {
    if (step !== 3 || !readinessSupported) return;
    const be = backend();
    // Keyed on the dataset, not the array: a re-derived array of the same files must not restart the wait.
    const key = datasetKey;
    void readinessRound;
    const stop = watchReadiness(
      untrack(() => datasetBlobIds),
      {
        probe: (blobIds) => be.datasetReadiness!(blobIds),
        check: (run) => be.datasetReadyToTrain!(run),
        buildRun: () => untrack(readinessRun),
        onView: (view) => (readiness = { key, view }),
      }
    );
    return () => {
      stop();
      readiness = null;
    };
  });
  // Until the wait reports for this dataset, Start is held.
  const readinessView = $derived<ReadinessView>(
    readiness?.key === datasetKey
      ? readiness.view
      : readinessSupported
        ? { kind: 'checking', ready: 0, total: datasetBlobIds.length }
        : { kind: 'off' }
  );
  const readinessSettled = $derived(
    readinessView.kind === 'ready' || readinessView.kind === 'off'
  );
  // An edit pair goes as a whole, so Remove counts the pairs it takes out.
  const readinessUnusableCount = $derived.by(() => {
    if (readinessView.kind !== 'unusable') return undefined;
    const gone = new Set(readinessView.blobIds);
    if (!trainsPairs) return gone.size;
    return pairs.filter((p) => gone.has(p.before.blobId ?? '') || gone.has(p.after?.blobId ?? ''))
      .length;
  });

  /** The first run as the submit would send it, for the readiness whatif. */
  function readinessRun(): TrainingRunPayload | undefined {
    const run = selection?.runs[0];
    const params = run && runParams[runParamsKey(run)];
    if (!selection || !run || !params) return undefined;
    const edit = trainsPairs ? { items: pairItems(pairs), pairs: readyPairs.length } : undefined;
    return buildTrainingRuns(
      selection,
      images,
      runTrigger,
      reviewName,
      [{ run, params }],
      samplePrompts,
      ['yellow', 'blue'],
      labelMode,
      edit
    )[0];
  }

  function removeDatasetFiles(blobIds: string[]) {
    const gone = new Set(blobIds);
    if (trainsPairs)
      pairs = pairs.filter(
        (p) => !gone.has(p.before.blobId ?? '') && !gone.has(p.after?.blobId ?? '')
      );
    else images = images.filter((i) => !gone.has(i.blobId ?? ''));
  }

  // The dataset's own labels (joined tags or captions) — Review seeds its sample prompts from these.
  const datasetLabels = $derived.by(() => {
    if (!selection) return [];
    return images
      .filter(isTrainable)
      .map((i) => labelString(i, labelMode))
      .filter((l) => l.length > 0);
  });

  // Free the dataset preview object URLs when the flow unmounts (leaving to My-trainings). Reads
  // nothing reactive, so it's mount-only — not per-step; images and their previews live here and must
  // survive Back/Continue, so DataStep must not do this on its own unmount. Emptying the array is
  // load-bearing: a preview hydration resolving after teardown checks membership and revokes its
  // fresh URL instead of leaking it.
  $effect(() => () => {
    for (const img of images) URL.revokeObjectURL(img.previewUrl);
    images = [];
    for (const pair of pairs)
      for (const img of pairImgs(pair))
        if (img.previewUrl.startsWith('blob:')) URL.revokeObjectURL(img.previewUrl);
    pairs = [];
  });

  // Leaving Data drops its filter; only Review's "see which" hands one across a step change.
  function leaveData() {
    dataFilter = 'all';
  }

  function jump(n: number) {
    if (n > step) return;
    if (step === 2) leaveData();
    step = n;
  }

  function enterReview() {
    if (!selection) return;
    const t = runTrigger.trim();
    if (reviewNameSeed === null || reviewName === reviewNameSeed) {
      reviewName = t;
      reviewNameSeed = t;
    }
    // The seed key covers the trigger too: an unedited prompt list follows a trigger change, so the
    // samples always carry the word the run is being taught.
    const labels = trainsPairs
      ? JSON.stringify(readyPairs.map((p) => [p.id, p.instruction]))
      : JSON.stringify([t, ...datasetLabels]);
    const untouched = promptsSeed !== null && JSON.stringify(samplePrompts) === promptsSeed.prompts;
    if (samplePrompts.length === 0 || (untouched && labels !== promptsSeed!.labels)) {
      const seeded = trainsPairs ? seedEditPrompts(readyPairs) : [];
      samplePrompts = seeded.length ? seeded : seedPrompts(datasetLabels, t);
      promptsSeed = { labels, prompts: JSON.stringify(samplePrompts) };
    }
    const { loraType } = selection;
    runParams = Object.fromEntries(
      selection.runs.map((run) => {
        const key = runParamsKey(run);
        const existing = runParams[key];
        // Params still at the previous seed's defaults follow a trigger change (shuffle/keep) or a
        // LoRA type change (network size).
        const untouched =
          existing &&
          JSON.stringify(existing) ===
            JSON.stringify(defaultRunParams(run, paramsSeedTrigger, paramsSeedLoraType));
        return [key, existing && !untouched ? { ...defaultRunParams(run, t, loraType), ...existing } : defaultRunParams(run, t, loraType)];
      })
    );
    paramsSeedTrigger = t;
    paramsSeedLoraType = loraType;
    leaveData();
    step = 3;
  }

  // The one write in the whole flow: assemble each run and submit real workflow(s), then land on the run
  // to watch it live — a single run opens its detail, a sweep goes to the list. Errors propagate to
  // ReviewStep, which shows them on the Start button.
  // One key per batch, kept across a failed Start so a retry finds the runs a lost response hid
  // instead of charging them again; replaced once a Start lands. Run i's key is this plus its index.
  let submitKey = newSubmitKey();

  async function start(
    launched: LaunchedRun[],
    prompts: SamplePrompt[],
    name: string,
    currencies: string[],
    matureAck: boolean,
    reviewedMature: number
  ) {
    if (!selection) return;
    // An edit run's pairs go as blobs placed by path — each image was uploaded and scanned on its own.
    const edit = trainsPairs ? { items: pairItems(pairs), pairs: readyPairs.length } : undefined;
    const runs = buildTrainingRuns(
      selection,
      images,
      runTrigger,
      name,
      launched,
      prompts,
      currencies,
      labelMode,
      edit
    );
    const keyed = stampMature(runs, matureAck, reviewedMature).map((run, i) => ({
      ...run,
      submitKey: `${submitKey}${i.toString(16).padStart(4, '0')}`,
    }));
    const { workflowIds: ids, failure } = await backend().submitTraining(keyed);
    submitKey = newSubmitKey();
    if (failure)
      submitNotice.set(
        `Started ${ids.length} of ${runs.length} runs. The rest may not have started (${failure}); check your runs list before starting them again.`
      );
    // A single run opens its detail; a sweep (or a partial submit) goes to the list, where every run that
    // landed appears — so a partial failure never re-submits the successful, already-charged runs.
    await navigate(
      runs.length === 1 && ids[0] ? { view: 'run', workflowId: ids[0] } : { view: 'home' },
      { refreshAll: true }
    );
  }
</script>

<section class="flex flex-col gap-6">
  <div class="flex items-center justify-between gap-3">
    <nav class="flex min-w-0 items-center gap-1.5" aria-label="Training steps">
      {#each STEPS as s, i (s.n)}
        {@const state = s.n < step ? 'done' : s.n === step ? 'active' : 'todo'}
        <div class="flex items-center gap-1.5">
          <button
            type="button"
            onclick={() => jump(s.n)}
            aria-current={state === 'active' ? 'step' : undefined}
            class="flex shrink-0 items-center gap-2 transition {state === 'todo' ? 'opacity-50' : 'opacity-100'}"
          >
            <span
              class="grid h-6 w-6 place-items-center rounded-full border font-mono text-xs
                {state === 'active'
                ? 'border-primary text-primary ring-4 ring-primary/10'
                : state === 'done'
                  ? 'border-emerald-500 bg-emerald-500/15 text-emerald-400'
                  : 'border-dark-4 text-dark-2'}"
            >
              {#if state === 'done'}<IconCheck size={13} stroke={3} />{:else}{s.n}{/if}
            </span>
            <!-- Below sm only the current step is labelled, so the three steps fit one row. -->
            <span
              class="whitespace-nowrap text-sm font-semibold {state === 'active'
                ? 'text-dark-0'
                : 'sr-only text-dark-2 sm:not-sr-only'}"
            >
              {s.label}
            </span>
          </button>
          {#if i < STEPS.length - 1}
            <span class="h-px w-4 bg-dark-4 sm:w-8"></span>
          {/if}
        </div>
      {/each}
    </nav>
    <Button variant="outline" size="sm" onclick={onExit}>
      <IconArrowLeft size={15} stroke={2} class="mr-1.5 inline" />Exit
    </Button>
  </div>

  <ServiceStatusBanner />

  {#if step === 1}
    <SelectStep
      {prices}
      {enabledModelFlags}
      initial={selection}
      startInEdit={reusePairItems.length > 0}
      onContinue={(sel) => {
        if (sel.loraType !== selection?.loraType || sel.media !== selection?.media)
          presetType = sel.loraType;
        selection = sel;
        // Reset the label mode to the model's default only when the current choice isn't valid for it —
        // so Back/Continue on the same model keeps a user's tags↔captions choice, but switching to a
        // single-format model snaps to its format.
        const card = runCard(sel.runs[0]!);
        if (!labelOptions(card).includes(labelMode)) labelMode = card.label;
        step = 2;
      }}
    />
  {:else if step === 2 && selection && trainsPairs}
    <EditDataStep
      bind:pairs
      bind:reuseItems={reusePairItems}
      onContinue={enterReview}
      onBack={() => {
        leaveData();
        step = 1;
      }}
    />
  {:else if step === 2 && selection}
    <DataStep
      {selection}
      {prices}
      {reuseItems}
      bind:images
      bind:trigger
      bind:labelMode
      bind:autoLabel
      bind:filter={dataFilter}
      bind:excludeTags
      bind:excludeCharacter
      bind:excludeSource
      onContinue={enterReview}
      onBack={() => {
        leaveData();
        step = 1;
      }}
    />
  {:else if step === 3 && selection}
    <ReviewStep
      {selection}
      trigger={runTrigger}
      {labelMode}
      bind:name={reviewName}
      bind:prompts={samplePrompts}
      bind:params={runParams}
      bind:presetType
      bind:openAdvanced
      bind:acknowledgedAdvanced
      imageCount={trainableCount}
      {trainsPairs}
      matureCount={reviewMatureCount}
      readiness={readinessView}
      {readinessUnusableCount}
      onCheckReadinessAgain={() => readinessRound++}
      onRemoveFiles={removeDatasetFiles}
      onStart={start}
      onBack={() => (step = 2)}
      onShowMature={() => {
        dataFilter = 'mature';
        step = 2;
      }}
    />
  {/if}
</section>
