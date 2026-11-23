<script lang="ts">
  import {
    IconBoltFilled,
    IconSettings,
    IconChevronUp,
    IconChevronDown,
    IconAlertTriangle,
    IconCheck,
    IconX,
    IconArrowLeft,
    IconInfoCircle,
    IconPhotoPlus,
  } from '@tabler/icons-svelte';
  import { kohyaBound, KOHYA_BOUNDS, KOHYA_OPTIMIZERS, KOHYA_SCHEDULERS, kohyaFieldSupported } from '$lib/data/kohya';
  import { buzzMode } from '$lib/buzz-mode.svelte';
  import { nonBlueSpend } from '$lib/buzz-balance.svelte';
  import { FILES_PROCESSING_MESSAGE, FilesProcessingError } from '$lib/files-processing';
  import { holdsStart, readinessMessage, type ReadinessView } from './uploadReadiness';
  import { MatureRepriceError } from '$lib/mature-charge';
  import { serviceStatus } from '$lib/service-status.svelte';
  import BlueFirstNote from '$lib/components/BlueFirstNote.svelte';
  import BlueFirstToggle from '$lib/components/BlueFirstToggle.svelte';
  import StickySummary from '$lib/components/StickySummary.svelte';
  import { backend, hostConfig, hostLink } from '$lib/host';
  import {
    AI_TOOLKIT_OPTION_FIELDS,
    parseAiToolkitOptions,
  } from '@civitai/shared/training-options';
  import { debouncedQuote } from '$lib/debounced-quote.svelte';
  import { getTrainingLicenseTerms } from '@civitai/shared/generation-license';
  import { isAbort, uploadFile } from '$lib/upload';
  import '$lib/civitai-elements';
  import type { CivitaiCheckbox } from '@civitai/components/civitai-checkbox';
  import type { CivitaiNumberInput } from '@civitai/components/civitai-number-input';
  import type { CivitaiSelect } from '@civitai/components/civitai-select';
  import type { CivitaiTextInput } from '@civitai/components/civitai-text-input';
  import type { CivitaiTextarea } from '@civitai/components/civitai-textarea';
  import type { StudioChipGroup } from '$lib/elements/studio-chip-group';
  import {
    EXTRA_PARAM_FIELDS,
    loraTypeById,
    mediaCount,
    paramBounds,
    seenFor,
    TARGET_STEPS,
    typesForMedia,
    type ExtraParamField,
    type LabelType,
    type ParamBound,
  } from '$lib/data/trainingModels';
  import { isFlux2 } from '$lib/orchestrator-core';
  import {
    addSamplePrompt,
    defaultRunParams,
    isCustom,
    MAX_SAMPLE_PROMPTS,
    numberInputValue,
    PARAM_LABELS,
    optimizerLrParams,
    paramDeviations,
    paramDisplay,
    paramHelpText,
    promptHasTrigger,
    runCard,
    runEngine,
    runTrainingParams,
    runExtraCapabilities,
    runParamsKey,
    runTakesSampleImages,
    runTrainsPairs,
    runVersion,
    sampleImagesProblem,
    runVersionLabel,
    blockedSelectionMessage,
    filledPrompts,
    paramLockReason,
    paramNeedsRefundAck,
    withTrigger,
    type LaunchedRun,
    type NumericInput,
    type Run,
    type RunParams,
    type SamplePrompt,
    type Selection,
  } from './trainingFlow';

  // name / prompts / params / presetType and the Advanced panel state are owned by the flow so they
  // survive Back.
  let {
    selection,
    trigger,
    labelMode,
    name = $bindable(),
    prompts = $bindable(),
    params = $bindable(),
    presetType = $bindable(),
    openAdvanced = $bindable(),
    acknowledgedAdvanced = $bindable(),
    imageCount,
    repeated,
    trainsPairs = false,
    matureCount: scannedMature,
    readiness = { kind: 'off' },
    readinessUnusableCount,
    onCheckReadinessAgain,
    onRemoveFiles,
    onStart,
    onBack,
    onShowMature,
  }: {
    selection: Selection;
    /** The dataset's trigger word (may be empty) — every sample prompt should carry it. */
    trigger: string;
    /** The dataset's label format — gates the tag-only advanced fields. */
    labelMode: LabelType;
    name: string;
    prompts: SamplePrompt[];
    /** Keyed by `runParamsKey`; the flow guarantees an entry for every run in `selection`. */
    params: Record<string, RunParams>;
    presetType: string;
    /** `runParamsKey` of the run whose Advanced panel is open, or '' when none is. */
    openAdvanced: string;
    /** Refund-forfeit acknowledgements, keyed by `runParamsKey`. */
    acknowledgedAdvanced: Record<string, boolean>;
    /** Items the dataset sends, counting each per-image repeat copy. */
    imageCount: number;
    /** Images set to repeat, the extra copies they add to `imageCount`, and the highest repeat. */
    repeated?: { images: number; extra: number; max: number };
    /** An edit LoRA: `imageCount` counts before/after pairs, which the copy names as such. */
    trainsPairs?: boolean;
    /** Trainable images whose upload scan rated them mature (R and up). */
    matureCount: number;
    /** Whether every dataset file is ready to train; `off` leaves Start to the other checks. */
    readiness?: ReadinessView;
    /** How many images or pairs Remove takes out when files can't be used. */
    readinessUnusableCount?: number;
    onCheckReadinessAgain: () => void;
    onRemoveFiles: (blobIds: string[]) => void;
    onStart: (
      launched: LaunchedRun[],
      prompts: SamplePrompt[],
      name: string,
      currencies: string[],
      matureCount: number
    ) => Promise<void>;
    onBack: () => void;
    /** Back to the Data step, filtered to the mature images. */
    onShowMature: () => void;
  } = $props();

  const datasetCount = $derived(
    trainsPairs
      ? `${imageCount.toLocaleString()} ${imageCount === 1 ? 'pair' : 'pairs'}`
      : repeated
      ? `${mediaCount(imageCount - repeated.extra, selection.media)} + ${repeated.extra.toLocaleString()} ${repeated.extra === 1 ? 'repeat' : 'repeats'}`
      : mediaCount(imageCount, selection.media)
  );

  let starting = $state(false);
  let startError = $state('');
  let filesProcessing = $state(false);

  // Moderators can switch training off on the main app; the flow's banner carries their message.
  const trainingDisabled = $derived(serviceStatus.value?.available === false);
  // A run on a model that went down after it was picked (a stale tab, a restored draft).
  const blockedMessage = $derived(blockedSelectionMessage(selection.runs, serviceStatus.value));

  // Green (membership) Buzz can't pay for NSFW training, so spending it requires an explicit attestation.
  let attestSfw = $state(false);
  const needsAttestation = $derived(buzzMode.value === 'green');

  const runLicenses = $derived([
    ...new Map(
      selection.runs.flatMap((run) => {
        const ecosystem = runVersion(run).ecosystem;
        const terms = getTrainingLicenseTerms(ecosystem);
        return terms ? [[terms.key, { ecosystem, terms }] as const] : [];
      })
    ).values(),
  ]);
  const licenseStatus = debouncedQuote(
    () =>
      runLicenses.length > 0 && backend().pendingLicenses
        ? runLicenses.map((license) => license.ecosystem).join()
        : null,
    () =>
      backend()
        .pendingLicenses!()
        .then(
          (pending) => ({ pending }),
          () => ({ pending: null })
        ),
    0
  );
  // Unknown (a failed check) asks nothing here: the submit's own refusal names the licence.
  const licensesToAccept = $derived(
    runLicenses.filter((license) => licenseStatus.value?.pending?.includes(license.ecosystem))
  );
  const checkingLicenses = $derived(
    runLicenses.length > 0 && !!backend().pendingLicenses && licenseStatus.value === undefined
  );
  let acceptingLicense = $state(false);
  let licenseError = $state('');
  async function acceptLicense(ecosystem: string) {
    acceptingLicense = true;
    licenseError = '';
    try {
      await backend().acceptLicense!(ecosystem);
      licenseStatus.retry();
    } catch (e) {
      licenseError = e instanceof Error ? e.message : 'Could not accept the licence.';
    } finally {
      acceptingLicense = false;
    }
  }
  $effect(() => {
    if (!needsAttestation) attestSfw = false;
  });

  const membership = hostConfig().isPaidMember;
  // The server's own check can find mature images the upload scan hasn't rated yet; its refusal sets this.
  let refusedMature = $state(0);
  const matureCount = $derived(Math.max(scannedMature, refusedMature));
  const mature = $derived(matureCount > 0);


  const OPTIMIZERS = ['AdamW8Bit', 'Adafactor', 'Prodigy', 'Automagic'];
  // ai-toolkit's supported set — no `cosine_with_restarts` (the orchestrator rejects it).
  const LR_SCHEDULERS = ['cosine', 'constant', 'constant_with_warmup', 'linear'];

  const presetTypes = $derived(typesForMedia(selection.media));
  const typeName = $derived(loraTypeById(selection.loraType).name);

  const paramsAt = (i: number): RunParams => params[runParamsKey(selection.runs[i]!)]!;
  const advancedOpen = (i: number) => openAdvanced === runParamsKey(selection.runs[i]!);

  // Support refuses refunds on a poor result once advanced params were edited, so editing them needs
  // the same acknowledgement as the in-app trainer — per run, and again when its model changes.
  const advancedAcknowledged = (i: number) =>
    acknowledgedAdvanced[runParamsKey(selection.runs[i]!)] === true;
  const fieldLocked = (i: number, field: ParamField) =>
    paramNeedsRefundAck(field) && !advancedAcknowledged(i);

  const presetSeen = $derived(seenFor(presetType, selection.media));
  const GUIDANCE_HELP =
    'Sets only the "each image seen ~N×" target below — how much exposure this kind of LoRA usually needs. It does not change your type, base model or any training setting.';

  // REAL per-run quotes — a whatif of each run's exact config, not the linear "from"-quote scale
  // the earlier steps preview with. Orchestrator pricing has a base fee and per-epoch terms, so
  // the scale over-read by 90-190⚡ (and ignored the checkpoint count entirely); this number is
  // what Start will actually charge. Sample images are NOT billed separately — the quote covers
  // them — so nothing is added on top. Debounce/blank/latest-wins live in `debouncedQuote`.
  const quoteInputAt = (i: number) => {
    const run = selection.runs[i]!;
    const p = paramsAt(i);
    const config = runTrainingParams(run, p, labelMode, trigger, selection.loraType);
    return {
      ...config,
      model: config.customModel ?? config.model,
      imageCount: imageCount > 0 ? imageCount : undefined,
      editTraining: runTrainsPairs(run) || undefined,
    };
  };
  // An out-of-range Steps field is UNQUOTABLE, never "quote the default budget": the orchestrator
  // prices an omitted steps at its default, which would show a confident total for a config that
  // isn't on screen.
  const stepsInvalid = (i: number) => {
    const { steps } = paramsAt(i);
    return !(steps >= TARGET_STEPS.min && steps <= TARGET_STEPS.max);
  };
  const optionsProblem = (i: number): string | null => {
    const input = quoteInputAt(i);
    try {
      parseAiToolkitOptions({ ...input, engine: input.engine ?? 'ai-toolkit' }, input);
      return null;
    } catch {
      return 'Check dropout rates and warmup steps. Warmup cannot exceed total steps; rank dropout must be below 1.';
    }
  };
  const quoteInvalid = (i: number) => stepsInvalid(i) || optionsProblem(i) !== null;
  const quoteState = debouncedQuote(
    () =>
      JSON.stringify(
        selection.runs.map((_, i) => (quoteInvalid(i) ? 'invalid' : quoteInputAt(i)))
      ),
    () =>
      Promise.all(
        selection.runs.map((_, i) =>
          quoteInvalid(i)
            ? Promise.resolve(null)
            : backend()
                .quoteRun(quoteInputAt(i))
                .catch(() => null)
        )
      )
  );
  const quotes = $derived(quoteState.value);
  const quoting = $derived(quotes === undefined);
  const quoteFailed = (i: number) => !quoting && !quoteInvalid(i) && quotes?.[i]?.cost == null;

  // `null` (unpriced/invalid) for any run blanks the whole total (shown as "—") rather than
  // summing a total that quietly misses a run; `undefined` (still quoting) does the same, briefly.
  const runCostAt = (i: number) => quotes?.[i]?.cost ?? null;
  const runTotal = $derived.by(() => {
    let sum = 0;
    for (let i = 0; i < selection.runs.length; i++) {
      const cost = runCostAt(i);
      if (cost == null) return null;
      sum += cost;
    }
    return sum;
  });
  const total = $derived(runTotal);
  const spend = $derived(nonBlueSpend(total, buzzMode.value, { mature }));
  const runCostLabel = (i: number) => {
    const cost = runCostAt(i);
    return cost == null ? null : cost.toLocaleString();
  };
  const etaMin = $derived(
    Math.max(...selection.runs.map((_, i) => Math.max(1, Math.round((paramsAt(i).steps / 2000) * 18)))),
  );

  function seen(i: number) {
    const p = paramsAt(i);
    const batch = runEngine(selection.runs[i]!) === 'kohya' ? Number(p.batchSize) || 1 : 1;
    return imageCount > 0 ? Math.round((p.steps * batch) / imageCount) : 0;
  }
  function low(i: number) {
    return seen(i) < Math.round(presetSeen * 0.6);
  }

  // Only the "seen ~N×" guidance follows this — step defaults are fixed per base model, and the
  // run's type stays what Select chose (it's what the metadata records).
  function setPreset(id: string) {
    presetType = id;
  }
  function setSteps(i: number, v: string) {
    // Number, not parseInt: parseInt('1e4') is 1, which would quote and start a one-step run.
    const n = Number(v);
    paramsAt(i).steps = Number.isInteger(n) ? n : 0;
  }
  // A cleared field stays 0 (invalid, blank quote) rather than snapping to 1 — a run the user can see is
  // unset beats a silently one-step run.
  function clampSteps(i: number) {
    const p = paramsAt(i);
    if (p.steps > 0) p.steps = Math.min(TARGET_STEPS.max, Math.max(TARGET_STEPS.min, p.steps));
  }

  // Per-model input bounds and Flux.2 gating (imageResourceTraining takes no hyperparameters).
  const boundsFor = (i: number) =>
    runEngine(selection.runs[i]!) === 'kohya'
      ? KOHYA_BOUNDS
      : paramBounds(runCard(selection.runs[i]!));
  const noAdvancedParams = (run: Run) => isFlux2(runVersion(run).engine);

  type ParamField = keyof RunParams;
  interface FieldDef {
    field: ParamField;
    kind: 'number' | 'select' | 'bool' | 'text';
    options?: string[];
  }
  const CORE_FIELDS: FieldDef[] = [
    { field: 'epochs', kind: 'number' },
    { field: 'batchSize', kind: 'number' },
    { field: 'unetLr', kind: 'number' },
    { field: 'textEncoderLr', kind: 'number' },
    { field: 'networkDim', kind: 'number' },
    { field: 'networkAlpha', kind: 'number' },
    { field: 'resolution', kind: 'number' },
    { field: 'lrScheduler', kind: 'select', options: LR_SCHEDULERS },
    { field: 'optimizer', kind: 'select', options: OPTIMIZERS },
  ];
  const KOHYA_FIELDS: FieldDef[] = [
    { field: 'negativePrompt', kind: 'text' },
    { field: 'numRepeats', kind: 'number' },
    { field: 'enableBucket', kind: 'bool' },
    { field: 'clipSkip', kind: 'number' },
    { field: 'lrSchedulerNumCycles', kind: 'number' },
    { field: 'seed', kind: 'number' },
    { field: 'fp8Base', kind: 'bool' },
    { field: 'blocksToSwap', kind: 'number' },
    { field: 'vParameterization', kind: 'select', options: ['auto', 'false', 'true'] },
    { field: 'zeroTerminalSnr', kind: 'select', options: ['auto', 'false', 'true'] },
  ];
  const coreFields = (i: number): FieldDef[] => {
    const run = selection.runs[i]!;
    if (runEngine(run) !== 'kohya') return CORE_FIELDS;
    return [
      ...CORE_FIELDS.map((field) =>
        field.field === 'optimizer' ? { ...field, options: KOHYA_OPTIMIZERS }
          : field.field === 'lrScheduler' ? { ...field, options: KOHYA_SCHEDULERS }
          : field
      ),
      ...KOHYA_FIELDS.filter((field) => kohyaFieldSupported(field.field, runVersion(run).ecosystem)),
    ];
  };
  const optionLabel = (value: string) =>
    ({ auto: 'Auto (checkpoint metadata)', true: 'On', false: 'Off' }[value] ?? value);
  const EXTRA_KIND: Record<ExtraParamField, FieldDef['kind']> = {
    lrWarmupSteps: 'number',
    captionDropoutRate: 'number',
    rankDropout: 'number',
    trainConv: 'bool',
    shuffleTokens: 'bool',
    keepTokens: 'number',
    minSnrGamma: 'number',
    noiseOffset: 'number',
    flipAugmentation: 'bool',
  };
  const EXTRA_FIELDS: FieldDef[] = EXTRA_PARAM_FIELDS.map((field) => ({
    field,
    kind: EXTRA_KIND[field],
  }));
  const isExtra = (field: ParamField): field is ExtraParamField =>
    EXTRA_PARAM_FIELDS.includes(field as ExtraParamField);

  const defaultsAt = (i: number) =>
    defaultRunParams(selection.runs[i]!, trigger, selection.loraType);
  const capsAt = (i: number) => runExtraCapabilities(selection.runs[i]!, labelMode, paramsAt(i));
  const deviationsByRun = $derived(
    selection.runs.map((run, i) =>
      paramDeviations(run, paramsAt(i), labelMode, trigger, selection.loraType)
    )
  );
  const deviationsAt = (i: number) => deviationsByRun[i] ?? [];
  // The Advanced panel's own count — Steps lives in the header, Checkpoints in the panel.
  const advancedDeviationsAt = (i: number) => deviationsAt(i).filter((d) => d.field !== 'steps');
  const deviates = (i: number, field: ParamField) =>
    deviationsAt(i).some((d) => d.field === field);
  const supportedExtras = (i: number) => {
    const caps = capsAt(i);
    return EXTRA_FIELDS.filter((f) => caps[f.field as ExtraParamField].supported);
  };
  const unsupportedExtras = (i: number): { reason: string; labels: string[] }[] => {
    const caps = capsAt(i);
    const aiToolkit = runEngine(selection.runs[i]!) === 'ai-toolkit';
    const groups = new Map<string, string[]>();
    for (const f of EXTRA_FIELDS) {
      const cap = caps[f.field as ExtraParamField];
      if (cap.supported) continue;
      if (!aiToolkit && (AI_TOOLKIT_OPTION_FIELDS as readonly string[]).includes(f.field)) continue;
      const reason = cap.reason ?? 'Not available for this model.';
      groups.set(reason, [...(groups.get(reason) ?? []), PARAM_LABELS[f.field]]);
    }
    return [...groups].map(([reason, labels]) => ({ reason, labels }));
  };
  const fieldBound = (i: number, field: ParamField): ParamBound | undefined =>
    runEngine(selection.runs[i]!) === 'kohya' ? kohyaBound(field, runVersion(selection.runs[i]!).ecosystem)
      : isExtra(field) ? capsAt(i)[field].bound : boundsFor(i)[field];
  const helpFor = (i: number, field: ParamField): string => {
    const run = selection.runs[i]!;
    const lockReason = paramLockReason(run, field);
    if (lockReason) return lockReason;
    return paramHelpText(field, run.cardType, defaultsAt(i), paramsAt(i));
  };

  function setField(i: number, field: ParamField, value: NumericInput | boolean) {
    const p = paramsAt(i);
    if (field === 'epochs') {
      const b = boundsFor(i).epochs;
      const n = parseInt(String(value));
      p.epochs = Number.isFinite(n) ? Math.min(b.max, Math.max(b.min, n)) : b.min;
      return;
    }
    if (field === 'steps') {
      setSteps(i, String(value));
      return;
    }
    (p as unknown as Record<string, NumericInput | boolean>)[field] = value;
    if (field === 'optimizer') Object.assign(p, optimizerLrParams(selection.runs[i]!, p));
    // Shuffling with nothing kept would move the trigger word away from the front of every
    // caption — keep one, as the main trainer does when a trigger is set.
    if (field === 'shuffleTokens' && value === true && trigger.trim() && Number(p.keepTokens) === 0)
      p.keepTokens = '1';
  }
  function commitNumber(i: number, field: ParamField, input: CivitaiTextInput, bound: ParamBound | undefined) {
    const text = input.value.trim();
    if (text !== '' && !Number.isFinite(Number(text))) {
      input.value = String(paramsAt(i)[field]);
      return;
    }
    setField(i, field, text);
    if (bound) clampField(i, field, bound);
  }
  function resetField(i: number, field: ParamField) {
    setField(i, field, defaultsAt(i)[field]);
  }
  // Clamp a numeric string field into the model's [min, max] on blur, so a user can't submit out-of-range.
  function clampField(i: number, field: ParamField, bound: ParamBound) {
    const p = paramsAt(i) as unknown as Record<string, NumericInput | boolean>;
    // Leave a cleared field blank — Number('') is 0, which would clamp up to `min`; the Start payload
    // fills a blank with the model's default instead.
    if (typeof p[field] === 'string' && !p[field].trim()) return;
    const n = Number(p[field]);
    if (!Number.isFinite(n)) return;
    const rounded = runEngine(selection.runs[i]!) === 'kohya' && bound.step >= 1 ? Math.round(n / bound.step) * bound.step : n;
    const clamped = Math.min(bound.max, Math.max(bound.min, rounded));
    if (clamped !== n) p[field] = clamped;
  }
  function addPrompt() {
    prompts = addSamplePrompt(prompts);
  }
  function removePrompt(i: number) {
    if (prompts.length <= 1) return;
    clearImage(prompts[i]!.id);
    prompts = prompts.filter((_, k) => k !== i);
  }
  function insertTrigger(i: number) {
    prompts[i]!.text = withTrigger(trigger, prompts[i]!.text);
  }
  // Edit LoRAs are judged by how they change an input image, so their sample rows take one.
  const takesImages = $derived(selection.runs.some(runTakesSampleImages));
  const someRunsTextOnly = $derived(takesImages && !selection.runs.every(runTakesSampleImages));
  const imagesProblem = $derived(takesImages ? sampleImagesProblem(prompts) : null);
  // Keyed by prompt id. An upload outliving its row (removed mid-upload) is aborted.
  let imageUploads = $state<Record<number, AbortController>>({});
  let imageErrors = $state<Record<number, string>>({});
  const uploadingImage = $derived(Object.keys(imageUploads).length > 0);

  async function attachImage(id: number, file: File | undefined) {
    if (!file) return;
    imageUploads[id]?.abort();
    const controller = new AbortController();
    imageUploads[id] = controller;
    delete imageErrors[id];
    try {
      const { url } = await uploadFile(file, () => {}, controller.signal);
      if (!url) throw new Error('Upload finished but the image is not ready yet — retry.');
      const row = prompts.find((p) => p.id === id);
      if (row) row.image = { url, name: file.name };
    } catch (e) {
      if (!isAbort(e)) imageErrors[id] = e instanceof Error ? e.message : 'Upload failed';
    } finally {
      if (imageUploads[id] === controller) delete imageUploads[id];
    }
  }
  function clearImage(id: number) {
    imageUploads[id]?.abort();
    const row = prompts.find((p) => p.id === id);
    if (row) row.image = undefined;
    delete imageErrors[id];
  }
  $effect(() => () => {
    for (const controller of Object.values(imageUploads)) controller.abort();
  });

  const triggerText = $derived(trigger.trim());
  const promptsMissingTrigger = $derived(
    triggerText
      ? prompts.filter((p) => p.text.trim() && !promptHasTrigger(triggerText, p.text)).length
      : 0
  );
  // Blank rows generate no sample image, so they are not counted.
  const filledCount = $derived(filledPrompts(prompts.map((p) => p.text)).length);
  // With Blue first on (the default), the moment the price exceeds the Blue balance the remainder
  // comes out of yellow/green — real money. Testers were charged Yellow
  // without ever being told, and the same run cost Blue one day and Yellow the next as balances
  // drifted. Anything beyond Blue requires an explicit confirmation naming the amount — and when
  // the balance is UNKNOWN (a host without getBuzzBalances, a buzz-service blip), fail safe:
  // confirm with "up to the full price" rather than reverting to silent spending.
  // `confirmSpend` is the dialog's payload and outlives the close animation (nulling it on close
  // blanks the outgoing frame's copy); `spendDialogOpen` alone drives visibility.
  let confirmSpend = $state<{
    amount: number;
    currency: 'yellow' | 'green';
    uncertain: boolean;
  } | null>(null);
  let spendDialogOpen = $state(false);

  // total == null means a quote is in flight or failed — never submit without a shown price
  // (nonBlueSpend(null) is null, so this would otherwise skip the spend confirmation too).
  const startBlocked = $derived(
    starting ||
      trainingDisabled ||
      !!blockedMessage ||
      total == null ||
      (needsAttestation && !attestSfw) ||
      !!imagesProblem ||
      uploadingImage ||
      checkingLicenses ||
      licensesToAccept.length > 0 ||
      holdsStart(readiness)
  );
  const readinessNote = $derived(
    readinessMessage(readiness, {
      unusableCount: readinessUnusableCount,
      noun: trainsPairs ? 'pair' : 'file',
    })
  );

  function start() {
    if (startBlocked) return;
    if (spend) {
      confirmSpend = spend;
      spendDialogOpen = true;
      return;
    }
    void reallyStart();
  }

  async function reallyStart() {
    if (starting || trainingDisabled || blockedMessage) return;
    spendDialogOpen = false;
    starting = true;
    startError = '';
    filesProcessing = false;
    try {
      await onStart(
        selection.runs.map((run, i) => ({ run, params: paramsAt(i) })),
        prompts,
        name,
        buzzMode.currencies,
        matureCount
      );
    } catch (e) {
      if (e instanceof MatureRepriceError) refusedMature = e.matureCount;
      if (e instanceof FilesProcessingError) filesProcessing = true;
      else startError = e instanceof Error ? e.message : 'Could not start training';
    } finally {
      starting = false;
    }
  }

  const multi = $derived(selection.runs.length > 1);
</script>

{#snippet help(text: string, subject: string)}
  <studio-popover>
    <button
      slot="trigger"
      type="button"
      aria-label="About {subject}"
      class="relative inline-flex text-dark-2 after:absolute after:-inset-2 after:content-[''] transition-colors hover:text-dark-0"
    >
      <IconInfoCircle size={13} stroke={2} />
    </button>
    <p class="m-0 max-w-[300px] text-xs leading-snug">{text}</p>
  </studio-popover>
{/snippet}

{#snippet sampleImage(p: SamplePrompt)}
  {#if imageUploads[p.id]}
    <div class="grid size-9 shrink-0 place-items-center rounded-md border border-dark-4 bg-dark-7">
      <civitai-loader size="sm" label="Uploading input image"></civitai-loader>
    </div>
  {:else if p.image}
    <div class="group relative size-9 shrink-0">
      <img
        src={p.image.url}
        alt="Input for sample: {p.image.name}"
        title={p.image.name}
        class="size-9 rounded-md border border-dark-4 object-cover"
      />
      <button
        type="button"
        aria-label="Remove input image"
        onclick={() => clearImage(p.id)}
        class="absolute -right-1.5 -top-1.5 grid size-4 place-items-center rounded-full border border-dark-4 bg-dark-6 text-dark-1 opacity-0 transition group-hover:opacity-100 focus-visible:opacity-100"
      >
        <IconX size={10} stroke={2.5} />
      </button>
    </div>
  {:else}
    <label
      class="grid size-9 shrink-0 cursor-pointer place-items-center rounded-md border border-dashed border-dark-4 text-dark-2 transition-colors hover:border-primary hover:text-primary"
      title="Add an input image"
    >
      <IconPhotoPlus size={16} stroke={2} />
      <input
        type="file"
        accept="image/*"
        class="sr-only"
        aria-label="Add an input image"
        onchange={(e) => {
          const input = e.currentTarget;
          void attachImage(p.id, input.files?.[0]);
          input.value = '';
        }}
      />
    </label>
  {/if}
{/snippet}

{#snippet recommendedHint(i: number, field: ParamField, display: string)}
  <span class="font-mono text-[11px] text-buzz">
    recommended {display}
    <button
      type="button"
      onclick={() => resetField(i, field)}
      class="ml-1 font-semibold text-primary underline-offset-2 hover:underline"
    >
      Reset
    </button>
  </span>
{/snippet}

{#snippet paramRow(i: number, f: FieldDef)}
  {@const locked = paramLockReason(selection.runs[i]!, f.field) !== undefined}
  {@const changed = deviates(i, f.field)}
  {@const bound = fieldBound(i, f.field)}
  {@const unacknowledged = fieldLocked(i, f.field)}
  {@const label = `${PARAM_LABELS[f.field]}${locked ? ' (unavailable)' : ''}`}
  <!-- Kit fields are named only by their visible label, so each parameter is a labelled field; the
       help and Reset sit at the label's right edge. -->
  <div class="relative min-w-0">
    <span class="absolute right-0 top-0 z-10 flex items-center gap-1.5">
      {#if changed}
        {@render recommendedHint(i, f.field, paramDisplay(defaultsAt(i)[f.field]))}
      {/if}
      {@render help(helpFor(i, f.field), PARAM_LABELS[f.field])}
    </span>
    {#if f.kind === 'text'}
      <civitai-textarea
        size="sm"
        {label}
        rows={2}
        value={String(paramsAt(i)[f.field])}
        disabled={unacknowledged}
        oninput={(e: Event) => setField(i, f.field, (e.currentTarget as CivitaiTextarea).value)}
      ></civitai-textarea>
    {:else if f.kind === 'bool'}
      <civitai-checkbox
        size="sm"
        class="block pt-1"
        {label}
        checked={Boolean(paramsAt(i)[f.field])}
        disabled={unacknowledged}
        onchange={(e: Event) => setField(i, f.field, (e.currentTarget as CivitaiCheckbox).checked)}
      ></civitai-checkbox>
    {:else if f.kind === 'select'}
      <civitai-select
        size="sm"
        {label}
        data={(f.options ?? []).map((o) => ({ value: o, label: optionLabel(o) }))}
        value={String(paramsAt(i)[f.field])}
        disabled={unacknowledged}
        onchange={(e: Event) => setField(i, f.field, (e.currentTarget as CivitaiSelect).value)}
      ></civitai-select>
    {:else}
      <!-- A text input committed on change, not civitai-number-input: that one rewrites its input on
           every keystroke, which wipes `1e` on the way to `1e-4` and turns `0.000` into `0`. -->
      <civitai-text-input
        size="sm"
        {label}
        value={String(paramsAt(i)[f.field])}
        disabled={locked || unacknowledged}
        onchange={(e: Event) => commitNumber(i, f.field, e.currentTarget as CivitaiTextInput, bound)}
      ></civitai-text-input>
    {/if}
  </div>
{/snippet}

<div class="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
  <div class="flex min-w-0 flex-col gap-5">
    <div>
      <h2 class="m-0 text-xl font-semibold text-white">Review &amp; start</h2>
      <p class="mt-1 text-sm text-dark-2">
        Steps are set to your model's recommended budget. Tweak if you like — everything else is
        optional.
      </p>
    </div>

    <civitai-card padding="md" with-border>
      <civitai-text-input
        label="Name your LoRA"
        description="Shown as the run's title; you can rename it later."
        placeholder="e.g. my_character — defaults to your trigger word"
        value={name}
        oninput={(e: Event) => (name = (e.currentTarget as CivitaiTextInput).value)}
      ></civitai-text-input>
    </civitai-card>

    <div class="flex flex-wrap items-center justify-between gap-2">
      <div class="font-mono text-xs uppercase tracking-wider text-dark-2">Training runs</div>
      <!-- The Character/Style/Concept exposure targets are about subjects; an edit run has none. -->
      <div class="flex flex-wrap items-center gap-1.5" class:hidden={trainsPairs}>
        <span class="inline-flex items-center gap-1 font-mono text-xs text-dark-2">
          exposure guidance {@render help(GUIDANCE_HELP, 'exposure guidance')}
        </span>
        <studio-chip-group
          aria-label="Exposure guidance"
          data={presetTypes.map((t) => ({
            value: t.id,
            label: t.name,
            title: `Recommended exposure for a ${t.name.toLowerCase()}: ~${seenFor(t.id, selection.media)}× per image`,
          }))}
          value={presetType}
          onchange={(e: Event) => setPreset((e.currentTarget as StudioChipGroup).value as typeof presetType)}
        ></studio-chip-group>
      </div>
    </div>

    <div class="flex flex-col gap-3">
      {#each selection.runs as run, i (run.id)}
        {@const card = runCard(run)}
        <div class="overflow-hidden rounded-xl border border-dark-4">
          <div class="flex flex-wrap items-center gap-3 bg-dark-6 px-4 py-3">
            <div>
              <div class="text-sm font-bold text-dark-0">
                {multi ? `Run ${i + 1} · ` : ''}{card.name}
                {runVersionLabel(run)}{isCustom(run) ? ' · custom' : ''}{runEngine(run) === 'kohya' ? ' · Kohya' : ''}
              </div>
              {#if noAdvancedParams(run)}
                <div class="mt-1 font-mono text-xs text-dark-2">
                  No advanced settings for this model
                </div>
              {:else}
                <civitai-button
                  class="mt-1"
                  size="sm"
                  variant={advancedOpen(i) ? 'light' : 'subtle'}
                  aria-expanded={advancedOpen(i)}
                  onclick={() => (openAdvanced = advancedOpen(i) ? '' : runParamsKey(run))}
                >
                  <span slot="left"><IconSettings size={14} stroke={2} /></span>
                  Advanced settings{advancedDeviationsAt(i).length > 0
                    ? ` · ${advancedDeviationsAt(i).length} changed`
                    : ''}
                  <span slot="right"
                    >{#if advancedOpen(i)}<IconChevronUp size={13} stroke={2} />{:else}<IconChevronDown
                        size={13}
                        stroke={2}
                      />{/if}</span
                  >
                </civitai-button>
              {/if}
            </div>
            <div class="ml-auto flex w-32 flex-col">
              <civitai-number-input
                size="sm"
                label="Steps"
                min={String(TARGET_STEPS.min)}
                max={String(TARGET_STEPS.max)}
                step={String(TARGET_STEPS.step)}
                value={String(paramsAt(i).steps || '')}
                error={stepsInvalid(i)
                  ? `${TARGET_STEPS.min.toLocaleString()}–${TARGET_STEPS.max.toLocaleString()}`
                  : ''}
                oninput={(e: Event) => setSteps(i, (e.currentTarget as CivitaiNumberInput).value)}
                onfocusout={() => clampSteps(i)}
              ></civitai-number-input>
              {#if deviates(i, 'steps')}
                <span class="mt-0.5 whitespace-nowrap">
                  {@render recommendedHint(i, 'steps', defaultsAt(i).steps.toLocaleString())}
                </span>
              {/if}
            </div>
            <span class="w-20 text-right font-mono text-sm text-buzz">
              {#if quoting}…{:else}{runCostLabel(i) ?? '—'}{/if}
            </span>
          </div>

          {#if trainsPairs}
            <div class="bg-dark-6 px-4 pb-3 font-mono text-xs text-dark-2">
              each pair seen ~{seen(i)}×
            </div>
          {:else}
          <div class="flex items-center gap-1 bg-dark-6 px-4 pb-3 font-mono text-xs {low(i) ? 'text-buzz' : 'text-emerald-400'}">
            {#if low(i)}<IconAlertTriangle size={13} stroke={2} class="shrink-0" />{:else}<IconCheck
                size={13}
                stroke={2}
                class="shrink-0"
              />{/if}each image seen ~{seen(i)}× ({low(i)
              ? `low — we recommend ~${presetSeen}×; results may be weak, no refund`
              : `good for a ${presetType}, target ~${presetSeen}×`})
            {#if runEngine(run) === 'kohya'}
              {@render help('Estimated from steps × batch size; partially filled batches can reduce exposure.', 'Image exposure')}
            {/if}
          </div>
          {#if repeated}
            <div class="bg-dark-6 px-4 pb-3 font-mono text-xs text-dark-2">
              includes {repeated.extra.toLocaleString()} repeat {repeated.extra === 1 ? 'copy' : 'copies'} · a ×{repeated.max} image is seen ~{seen(i) * repeated.max}×
            </div>
          {/if}
          {/if}

          {#if advancedOpen(i) && !noAdvancedParams(run)}
            {@const extras = supportedExtras(i)}
            {@const hidden = unsupportedExtras(i)}
            <div class="border-t border-dark-4 bg-dark-8 px-4 py-4">
              <div class="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                <span class="inline-flex items-center gap-1 font-mono text-xs uppercase tracking-wider text-primary">
                  <IconSettings size={12} stroke={2} />Advanced training settings
                </span>
                <span class="font-mono text-xs text-dark-2">
                  seeded with {card.name}'s recommended values — click (i) for what each does
                </span>
              </div>
              <civitai-alert
                class="mb-4 block"
                color="warning"
                heading="Editing advanced parameters forfeits your refund"
              >
                <p class="m-0 text-xs leading-snug">
                  These defaults are tuned for your selected model. If you change them and the
                  result is poor, the training is non-refundable. Steps, Checkpoints and the
                  negative prompt are not affected.
                </p>
                <civitai-checkbox
                  class="mt-2 block"
                  size="sm"
                  label="I understand and want to edit the advanced parameters"
                  checked={advancedAcknowledged(i)}
                  onchange={(e: Event) =>
                    (acknowledgedAdvanced[runParamsKey(run)] = (e.currentTarget as CivitaiCheckbox).checked)}
                ></civitai-checkbox>
              </civitai-alert>
              <div class="grid gap-x-6 gap-y-3 sm:grid-cols-2">
                {#each coreFields(i) as f (f.field)}
                  {@render paramRow(i, f)}
                {/each}
                {#each extras as f (f.field)}
                  {@render paramRow(i, f)}
                {/each}
              </div>
              {#if runEngine(run) === 'kohya'}
                <p class="mb-0 mt-3 text-xs text-dark-2">LoRA type: LoRA · Optimizer arguments: automatic</p>
              {/if}
              {#if hidden.length > 0}
                <ul class="m-0 mt-2.5 list-none p-0 font-mono text-[11px] leading-snug text-dark-2">
                  {#each hidden as group (group.reason)}
                    <li>Not offered: {group.labels.join(' · ')} — {group.reason}</li>
                  {/each}
                </ul>
              {/if}
            </div>
          {/if}
        </div>
      {/each}
    </div>

    <div>
      <div class="mb-2 font-mono text-xs uppercase tracking-wider text-dark-2">
        Sample prompts <span class="lowercase text-dark-2">· the test images generated as it trains</span>
      </div>
      <civitai-card padding="md" with-border>
        <div class="flex flex-col gap-3">
          {#each prompts as p, i (p.id)}
            {@const missing =
              triggerText !== '' && p.text.trim() !== '' && !promptHasTrigger(triggerText, p.text)}
            <div class="flex flex-col gap-1">
              <div class="flex items-center gap-2">
                {#if takesImages}
                  {@render sampleImage(p)}
                {/if}
                <civitai-text-input
                  class="min-w-0 flex-1"
                  label={`Sample prompt ${i + 1}`}
                  placeholder="Describe a test scene, e.g. standing in a forest at dusk"
                  value={p.text}
                  error={missing ? `Missing your trigger word "${triggerText}" — this sample won't test it.` : ''}
                  oninput={(e: Event) => (prompts[i]!.text = (e.currentTarget as CivitaiTextInput).value)}
                ></civitai-text-input>
                {#if prompts.length > 1}
                  <civitai-action-button
                    class="shrink-0 self-end"
                    label={`Remove prompt ${i + 1}`}
                    onclick={() => removePrompt(i)}
                  >
                    <span slot="icon"><IconX size={14} stroke={2} /></span>
                  </civitai-action-button>
                {/if}
              </div>
              {#if imageErrors[p.id]}
                <div class="font-mono text-[11px] text-red-400">{imageErrors[p.id]}</div>
              {/if}
              {#if missing}
                <div class="flex flex-wrap items-center gap-x-1.5 font-mono text-[11px]">
                  <button
                    type="button"
                    onclick={() => insertTrigger(i)}
                    class="font-semibold text-primary underline-offset-2 hover:underline"
                  >
                    Insert trigger
                  </button>
                </div>
              {/if}
            </div>
          {/each}
        </div>
        {#if prompts.length < MAX_SAMPLE_PROMPTS}
          <civitai-button class="mt-3" variant="outline" full-width onclick={addPrompt}>
            + Add sample prompt
          </civitai-button>
        {/if}
        <p class="mt-2.5 font-mono text-xs text-dark-2">
          {#if filledCount === 0}
            <span class="text-buzz">No sample prompt filled in: no test images will be generated.</span>
          {/if}
          Applied to every run.
          {#if takesImages}
            Add an input image to each prompt to render the samples as edits of it{someRunsTextOnly
              ? ' (on the runs whose model supports it; the others sample from text)'
              : ''}, or leave them all empty for text-only samples.
          {/if}
          {#if triggerText}
            Each sample starts with your trigger word "{triggerText}", so the images test what the
            LoRA is learning.
          {/if}
        </p>
      </civitai-card>
    </div>
  </div>

  <StickySummary>
    <h3 class="m-0 mb-3 font-mono text-xs uppercase tracking-widest text-dark-2">What you're starting</h3>
    <dl class="m-0 flex flex-col gap-1 text-sm">
      <div class="flex justify-between gap-2.5">
        <dt class="text-dark-2">Type</dt>
        <dd class="m-0 font-semibold text-dark-0">{typeName} · {selection.media}</dd>
      </div>
      <div class="flex justify-between gap-2.5">
        <dt class="text-dark-2">Dataset</dt>
        <dd class="m-0 font-semibold text-dark-0">
          {datasetCount} · {trainsPairs ? 'instructions' : labelMode === 'tag' ? 'tags' : 'captions'}
        </dd>
      </div>
      <div class="flex justify-between gap-2.5">
        <dt class="text-dark-2">Trigger word</dt>
        <dd class="m-0 truncate font-mono text-xs font-semibold text-dark-0" title={triggerText}>
          {triggerText || 'none'}
        </dd>
      </div>
      <div class="flex justify-between gap-2.5">
        <dt class="text-dark-2">Sample prompts</dt>
        <dd class="m-0 font-semibold {promptsMissingTrigger > 0 ? 'text-buzz' : 'text-dark-0'}">
          {filledCount}{promptsMissingTrigger > 0 ? ` · ${promptsMissingTrigger} without trigger` : ''}
        </dd>
      </div>
    </dl>
    {#each selection.runs as run, i (run.id)}
      {@const devs = deviationsAt(i).filter((d) => d.field !== 'steps' && d.field !== 'epochs')}
      {@const p = paramsAt(i)}
      <div class="mt-2.5 border-t border-dark-4 pt-2.5 text-sm">
        {#if optionsProblem(i)}
          <p class="text-sm text-red-300" role="alert">{optionsProblem(i)}</p>
        {/if}
        {#each quotes?.[i]?.warnings ?? [] as warning (warning)}
          <p class="text-sm text-buzz" role="status">Setting not applied: {warning}</p>
        {/each}

        <div class="font-semibold text-dark-0">
          {multi ? `Run ${i + 1} · ` : ''}{runCard(run).name}
          {runVersionLabel(run)}
        </div>
        {#if isCustom(run)}
          <div class="truncate font-mono text-[11px] text-dark-2" title={run.customAir}>
            {run.customName ?? run.customAir}
          </div>
        {/if}
        <div class="font-mono text-xs text-dark-2">
          {p.steps.toLocaleString()} steps · {p.epochs} checkpoint{p.epochs === 1 ? '' : 's'}
        </div>
        {#if noAdvancedParams(run)}
          <div class="font-mono text-xs text-dark-2">no advanced settings for this model</div>
        {:else if devs.length === 0}
          <div class="font-mono text-xs text-emerald-400">recommended settings</div>
        {:else}
          <ul class="m-0 mt-1 list-none p-0 font-mono text-xs">
            {#each devs as dev (dev.field)}
              <li class="flex justify-between gap-2">
                <span class="text-dark-2">{dev.label}</span>
                <span class="text-right">
                  <span class="text-dark-0">{dev.value}</span>
                  <span class="text-dark-2"> (rec. {dev.recommended})</span>
                </span>
              </li>
            {/each}
          </ul>
        {/if}
      </div>
    {/each}

    <h3 class="m-0 mb-3 mt-5 font-mono text-xs uppercase tracking-widest text-dark-2">Final price</h3>
    {#each selection.runs as run, i (run.id)}
      {@const costLabel = runCostLabel(i)}
      <div class="flex justify-between gap-2.5 border-b border-dark-4 py-2 text-sm">
        <span class="truncate text-dark-2">{multi ? `Run ${i + 1} · ` : ''}{runCard(run).name}</span>
        <span class="font-semibold text-dark-0">
          {#if costLabel}<IconBoltFilled size={13} stroke={2} class="mb-px inline" /> {costLabel}
          {:else if quoting}<span class="font-mono text-xs text-dark-2">pricing…</span>
          {:else if quoteFailed(i)}
            <button
              type="button"
              class="font-mono text-xs text-red-400 underline underline-offset-2"
              onclick={() => quoteState.retry()}
            >
              couldn't price — retry
            </button>
          {:else}—{/if}
        </span>
      </div>
    {/each}
    <div class="mt-2 flex items-baseline justify-between border-t border-dark-4 pt-3.5">
      <span class="text-sm text-dark-2">Total</span>
      <span class="font-mono text-2xl font-bold text-buzz">
        {#if total == null}—{:else}<IconBoltFilled size={20} stroke={2} class="mb-0.5 inline" /> {total.toLocaleString()}{/if}
      </span>
    </div>
    <div class="mt-1 text-right font-mono text-xs text-dark-2">
      ~{etaMin} min{multi ? ' · parallel' : ''} · {datasetCount}
    </div>

    {#if mature}
      <civitai-alert role="note" class="mt-3 block" color="warning">
        <span class="text-xs leading-snug">
          {matureCount}
          {matureCount === 1 ? 'image in your dataset was' : 'images in your dataset were'} rated
          <strong>mature</strong> (R or above).
          {#if scannedMature > 0}
            <button type="button" onclick={onShowMature} class="font-semibold text-primary hover:underline">
              See which
            </button>.
          {/if}
          Mature content can't be paid with <span class="text-emerald-400">Green</span> Buzz.
          {#if buzzMode.blueFirst}
            <span class="text-blue-400">Blue</span> Buzz pays first, and anything beyond it is
            charged in <span class="text-yellow-400">Yellow</span> Buzz.
          {:else}
            It is charged in <span class="text-yellow-400">Yellow</span> Buzz.
          {/if}
          {#if membership !== true && buzzMode.blueFirst}
            Without a membership, mature sample images from runs paid with
            <span class="text-blue-400">Blue</span> Buzz are blurred. Turn off Spend Blue first to pay
            in <span class="text-yellow-400">Yellow</span> and see them.
          {/if}
        </span>
      </civitai-alert>
      {#if buzzMode.locked}
        <BlueFirstToggle class="mt-3" />
      {/if}
    {:else}
      <BlueFirstNote class="mt-3" />
    {/if}

    {#if needsAttestation}
      <civitai-checkbox
        class="mt-3 block"
        size="sm"
        label="I confirm this training won't produce NSFW content."
        description="Green (membership) Buzz can't be spent on NSFW training."
        checked={attestSfw}
        onchange={(e: Event) => (attestSfw = (e.currentTarget as CivitaiCheckbox).checked)}
      ></civitai-checkbox>
    {/if}

    {#each licensesToAccept as { ecosystem, terms } (terms.key)}
      <civitai-alert role="note" class="mt-3 block" color="warning" heading={terms.title}>
        <div class="flex flex-col gap-2 text-xs leading-snug">
        <span>{terms.intro}</span>
        <ul class="list-disc pl-5">
          {#each terms.restrictions as line (line)}
            <li>{line}</li>
          {/each}
        </ul>
        <span>
          Read the
          <a href={terms.licenseUrl} target="_blank" rel="noopener noreferrer" class="underline">
            {terms.licenseName}</a
          >.
        </span>
        <civitai-button
          variant="outline"
          size="sm"
          loading={acceptingLicense}
          disabled={acceptingLicense}
          onclick={() => acceptLicense(ecosystem)}
        >
          I agree to these terms
        </civitai-button>
        {#if licenseError}
          <span class="text-red-400">{licenseError}</span>
        {/if}
        </div>
      </civitai-alert>
    {/each}

    <civitai-button
      class="mt-4"
      size="lg"
      full-width
      loading={starting}
      disabled={startBlocked}
      onclick={start}
    >
      <span slot="left"><IconBoltFilled size={16} stroke={2} /></span>
      {#if starting}Starting…{:else}{multi ? `Start ${selection.runs.length} runs` : 'Start training'}{/if}
    </civitai-button>
    {#if trainingDisabled}
      <p class="mt-2 text-center font-mono text-xs text-dark-2">
        Training is currently disabled — see the notice above.
      </p>
    {:else if blockedMessage}
      <p class="mt-2 text-center font-mono text-xs text-buzz">{blockedMessage}</p>
    {:else if readinessNote}
      <div class="mt-2 flex flex-col items-center gap-2">
        <p class="text-center font-mono text-xs text-dark-2">{readinessNote}</p>
        {#if readiness.kind === 'unusable'}
          {@const blobIds = readiness.blobIds}
          <civitai-button variant="outline" size="sm" onclick={() => onRemoveFiles(blobIds)}>
            Remove {(readinessUnusableCount ?? blobIds.length) === 1 ? 'it' : 'them'}
          </civitai-button>
        {:else if readiness.kind === 'slow'}
          <civitai-button variant="outline" size="sm" onclick={onCheckReadinessAgain}>Check again</civitai-button>
        {/if}
      </div>
    {:else if filesProcessing}
      <div class="mt-2 flex flex-col items-center gap-2">
        <p class="text-center font-mono text-xs text-dark-2">{FILES_PROCESSING_MESSAGE}</p>
        <civitai-button variant="outline" size="sm" disabled={startBlocked} onclick={start}>Try again</civitai-button>
      </div>
    {:else if startError}
      <p class="mt-2 text-center font-mono text-xs text-red-400">{startError}</p>
    {:else if imagesProblem}
      <p class="mt-2 text-center font-mono text-xs text-buzz">{imagesProblem}</p>
    {:else if total == null && !quoting}
      <p class="mt-2 text-center font-mono text-xs text-dark-2">
        We couldn't price every run right now — start is disabled until each run shows a cost.
      </p>
    {/if}
    <p class="mt-3 text-center font-mono text-xs text-dark-2">
      Refunded automatically if training fails
    </p>
  </StickySummary>
</div>

<div class="mt-6 flex items-center justify-between gap-3 border-t border-dark-4 pt-5">
  <civitai-button variant="outline" onclick={onBack}>
    <span slot="left"><IconArrowLeft size={15} stroke={2} /></span>Back
  </civitai-button>
  <span class="text-right font-mono text-xs text-dark-2">This is the only step that spends Buzz</span>
</div>

<civitai-confirm-dialog
  open={spendDialogOpen}
  destructive
  heading="This {confirmSpend?.uncertain ? 'can spend' : 'spends'} {confirmSpend?.currency === 'green'
    ? 'Green'
    : 'Yellow'} Buzz"
  confirm-label="Spend {confirmSpend?.uncertain ? 'up to ' : ''}{confirmSpend?.amount.toLocaleString()} {confirmSpend?.currency ===
  'green'
    ? 'Green'
    : 'Yellow'} and start"
  onconfirm={() => void reallyStart()}
  onclose={() => (spendDialogOpen = false)}
>
  <p class="m-0 text-sm text-dark-1">
    {#if !buzzMode.blueFirst}
      Blue Buzz first is off, so all <strong>{confirmSpend?.amount.toLocaleString()}</strong> of
      this run will come out of your {confirmSpend?.currency === 'green' ? 'Green' : 'Yellow'} Buzz.
    {:else if confirmSpend?.uncertain}
      Blue Buzz spends first, but your balance couldn't be read — up to
      <strong>{confirmSpend?.amount.toLocaleString()}</strong> of this run may come out of your
      {confirmSpend?.currency === 'green' ? 'Green' : 'Yellow'} Buzz.
    {:else}
      Your Blue Buzz covers part of this run; the remaining
      <strong>{confirmSpend?.amount.toLocaleString()}</strong> will come out of your
      {confirmSpend?.currency === 'green' ? 'Green' : 'Yellow'} Buzz.
    {/if}
    {#if !buzzMode.locked}
      You can switch which Buzz is used from the balance at the top of the page.
    {/if}
  </p>
</civitai-confirm-dialog>
