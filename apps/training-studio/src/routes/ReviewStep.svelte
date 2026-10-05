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
  } from '@tabler/icons-svelte';
  import { buzzMode } from '$lib/buzz-mode.svelte';
  import { nonBlueSpend } from '$lib/buzz-balance.svelte';
  import BlueFirstNote from '$lib/components/BlueFirstNote.svelte';
  import { backend, hostConfig, hostLink, portalProps } from '$lib/host';
  import { debouncedQuote } from '$lib/debounced-quote.svelte';
  import * as Dialog from '@civitai/ui/components/ui/dialog/index.js';
  import * as Tooltip from '@civitai/ui/components/ui/tooltip/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Checkbox } from '@civitai/ui/components/ui/checkbox/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import * as Select from '@civitai/ui/components/ui/select/index.js';
  import {
    EXTRA_PARAM_FIELDS,
    loraTypeById,
    mediaCount,
    paramBounds,
    seenFor,
    TARGET_STEPS,
    TE_TRAINING_UNSUPPORTED_REASON,
    typesForMedia,
    type ExtraParamField,
    type LabelType,
    type ParamBound,
  } from '$lib/data/trainingModels';
  import {
    defaultRunParams,
    isCustom,
    PARAM_HELP,
    PARAM_LABELS,
    paramDeviations,
    paramDisplay,
    promptHasTrigger,
    runCard,
    runExtraCapabilities,
    runParamsKey,
    runVersion,
    runVersionLabel,
    teLocked,
    withTrigger,
    type LaunchedRun,
    type NumericInput,
    type Run,
    type RunParams,
    type SamplePrompt,
    type Selection,
  } from './trainingFlow';

  // name / prompts / params / presetType are owned and seeded by the flow so they survive Back.
  let {
    selection,
    trigger,
    labelMode,
    name = $bindable(),
    prompts = $bindable(),
    params = $bindable(),
    presetType = $bindable(),
    imageCount,
    matureCount,
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
    imageCount: number;
    /** Trainable images whose upload scan rated them mature (R and up). */
    matureCount: number;
    onStart: (
      launched: LaunchedRun[],
      prompts: string[],
      name: string,
      currencies: string[]
    ) => Promise<void>;
    onBack: () => void;
    /** Back to the Data step, filtered to the mature images. */
    onShowMature: () => void;
  } = $props();

  let starting = $state(false);
  let startError = $state('');

  // Green (membership) Buzz can't pay for NSFW training, so spending it requires an explicit attestation.
  let attestSfw = $state(false);
  const needsAttestation = $derived(buzzMode.value === 'green');
  $effect(() => {
    if (!needsAttestation) attestSfw = false;
  });

  // Blue can't pay for mature content without a paid membership: the orchestrator takes Blue, refunds
  // it seconds after submit, and charges the whole price in Yellow. Users read that silent switch as a
  // billing bug, so it is warned here and confirmed at Start. Unknown membership warns too, hedged.
  const membership = hostConfig().isPaidMember;
  const blueExcluded = $derived(matureCount > 0 && membership !== true);


  const OPTIMIZERS = ['AdamW8Bit', 'Adafactor', 'Prodigy', 'Automagic'];
  // ai-toolkit's supported set — no `cosine_with_restarts` (the orchestrator rejects it).
  const LR_SCHEDULERS = ['cosine', 'constant', 'constant_with_warmup', 'linear'];

  const presetTypes = $derived(typesForMedia(selection.media));
  const typeName = $derived(loraTypeById(selection.loraType).name);

  const paramsAt = (i: number): RunParams => params[runParamsKey(selection.runs[i]!)]!;
  let openAdv = $state(-1);

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
    const v = runVersion(run);
    const p = paramsAt(i);
    return {
      ecosystem: v.ecosystem,
      modelVariant: v.modelVariant,
      version: v.version,
      engine: v.engine,
      model: isCustom(run) ? run.customAir?.trim() || undefined : v.air,
      steps: p.steps,
      epochs: p.epochs > 0 ? p.epochs : undefined,
      imageCount: imageCount > 0 ? imageCount : undefined,
    };
  };
  // An out-of-range Steps field is UNQUOTABLE, never "quote the default budget": the orchestrator
  // prices an omitted steps at its default, which would show a confident total for a config that
  // isn't on screen.
  const stepsInvalid = (i: number) => {
    const { steps } = paramsAt(i);
    return !(steps >= TARGET_STEPS.min && steps <= TARGET_STEPS.max);
  };
  const quoteState = debouncedQuote(
    () =>
      JSON.stringify(
        selection.runs.map((_, i) => (stepsInvalid(i) ? 'invalid' : quoteInputAt(i)))
      ),
    () =>
      Promise.all(
        selection.runs.map((_, i) =>
          stepsInvalid(i)
            ? Promise.resolve(null)
            : backend()
                .quoteRun(quoteInputAt(i))
                .catch(() => null)
        )
      )
  );
  const quotes = $derived(quoteState.value);
  const quoting = $derived(quotes === undefined);
  const quoteFailed = (i: number) => !quoting && !stepsInvalid(i) && quotes?.[i] == null;

  // `null` (unpriced/invalid) for any run blanks the whole total (shown as "—") rather than
  // summing a total that quietly misses a run; `undefined` (still quoting) does the same, briefly.
  const runCostAt = (i: number) => quotes?.[i] ?? null;
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
  const runCostLabel = (i: number) => {
    const cost = runCostAt(i);
    return cost == null ? null : cost.toLocaleString();
  };
  const etaMin = $derived(
    Math.max(...selection.runs.map((_, i) => Math.max(1, Math.round((paramsAt(i).steps / 2000) * 18)))),
  );

  function seen(i: number) {
    return imageCount > 0 ? Math.round(paramsAt(i).steps / imageCount) : 0;
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
  const boundsFor = (i: number) => paramBounds(runCard(selection.runs[i]!));
  const noAdvancedParams = (run: Run) => runVersion(run).engine === 'flux2-dev';

  type ParamField = keyof RunParams;
  interface FieldDef {
    field: ParamField;
    kind: 'number' | 'select' | 'bool';
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
  const EXTRA_KIND: Record<ExtraParamField, FieldDef['kind']> = {
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

  const defaultsAt = (i: number) => defaultRunParams(selection.runs[i]!);
  const capsAt = (i: number) => runExtraCapabilities(selection.runs[i]!, labelMode);
  const deviationsByRun = $derived(
    selection.runs.map((run, i) => paramDeviations(run, paramsAt(i), labelMode))
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
    const groups = new Map<string, string[]>();
    for (const f of EXTRA_FIELDS) {
      const cap = caps[f.field as ExtraParamField];
      if (cap.supported) continue;
      const reason = cap.reason ?? 'Not available for this model.';
      groups.set(reason, [...(groups.get(reason) ?? []), PARAM_LABELS[f.field]]);
    }
    return [...groups].map(([reason, labels]) => ({ reason, labels }));
  };
  const fieldBound = (i: number, field: ParamField): ParamBound | undefined =>
    isExtra(field) ? capsAt(i)[field].bound : boundsFor(i)[field];
  const helpFor = (i: number, field: ParamField): string => {
    const run = selection.runs[i]!;
    if (field === 'textEncoderLr' && teLocked(run))
      return `Not available for ${runCard(run).name} — ${TE_TRAINING_UNSUPPORTED_REASON}`;
    return PARAM_HELP[field].replace('{recommended}', paramDisplay(defaultsAt(i)[field]));
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
    // Shuffling with nothing kept would move the trigger word away from the front of every
    // caption — keep one, as the main trainer does when a trigger is set.
    if (field === 'shuffleTokens' && value === true && trigger.trim() && Number(p.keepTokens) === 0)
      p.keepTokens = '1';
  }
  function resetField(i: number, field: ParamField) {
    setField(i, field, defaultsAt(i)[field]);
  }
  // Clamp a numeric string field into the model's [min, max] on blur, so a user can't submit out-of-range.
  function clampField(i: number, field: ParamField, bound: ParamBound) {
    const p = paramsAt(i) as unknown as Record<string, NumericInput | boolean>;
    const n = Number(p[field]);
    if (!Number.isFinite(n)) return;
    const clamped = Math.min(bound.max, Math.max(bound.min, n));
    if (clamped !== n) p[field] = clamped;
  }
  function addPrompt() {
    const id = Math.max(-1, ...prompts.map((p) => p.id)) + 1;
    if (prompts.length < 6) prompts = [...prompts, { id, text: 'new scene' }];
  }
  function removePrompt(i: number) {
    if (prompts.length > 1) prompts = prompts.filter((_, k) => k !== i);
  }
  function insertTrigger(i: number) {
    prompts[i]!.text = withTrigger(trigger, prompts[i]!.text);
  }
  const triggerText = $derived(trigger.trim());
  const promptsMissingTrigger = $derived(
    triggerText ? prompts.filter((p) => !promptHasTrigger(triggerText, p.text)).length : 0
  );
  // Blue always spends first (it isn't offered in the picker), so the moment the price exceeds the
  // Blue balance the remainder comes out of yellow/green — real money. Testers were charged Yellow
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

  function start() {
    // total == null means a quote is in flight or failed — never submit without a shown price
    // (nonBlueSpend(null) is null, so this would otherwise skip the spend confirmation too).
    if (starting || total == null || (needsAttestation && !attestSfw)) return;
    const spend = nonBlueSpend(total, buzzMode.value, !blueExcluded);
    if (spend) {
      confirmSpend = spend;
      spendDialogOpen = true;
      return;
    }
    void reallyStart();
  }

  async function reallyStart() {
    if (starting) return;
    spendDialogOpen = false;
    starting = true;
    startError = '';
    try {
      await onStart(
        selection.runs.map((run, i) => ({ run, params: paramsAt(i) })),
        prompts.map((p) => p.text),
        name,
        buzzMode.currencies
      );
    } catch (e) {
      startError = e instanceof Error ? e.message : 'Could not start training';
    } finally {
      starting = false;
    }
  }

  const multi = $derived(selection.runs.length > 1);
</script>

{#snippet help(text: string, subject: string)}
  <Tooltip.Provider>
    <Tooltip.Root>
      <Tooltip.Trigger
        class="inline-flex text-dark-2 transition-colors hover:text-dark-0"
        aria-label="About {subject}"
      >
        <IconInfoCircle size={13} stroke={2} />
      </Tooltip.Trigger>
      <Tooltip.Content class="max-w-[300px] text-xs leading-snug" portalProps={portalProps()}>
        {text}
      </Tooltip.Content>
    </Tooltip.Root>
  </Tooltip.Provider>
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

{#snippet paramRow(i: number, f: FieldDef, last: boolean)}
  {@const locked = f.field === 'textEncoderLr' && teLocked(selection.runs[i]!)}
  {@const changed = deviates(i, f.field)}
  {@const bound = fieldBound(i, f.field)}
  <div
    class="grid grid-cols-[1fr_120px] items-center gap-2 py-1.5 text-sm {last
      ? ''
      : 'border-b border-dark-4/60'}"
  >
    <span class="flex min-w-0 flex-col">
      <span class="flex items-center gap-1 text-dark-2">
        {PARAM_LABELS[f.field]}
        {#if locked}<span>(unavailable)</span>{/if}
        {@render help(helpFor(i, f.field), PARAM_LABELS[f.field])}
      </span>
      {#if changed}
        {@render recommendedHint(i, f.field, paramDisplay(defaultsAt(i)[f.field]))}
      {/if}
    </span>
    {#if f.kind === 'bool'}
      <div class="flex h-7 items-center justify-end pr-1">
        <Checkbox
          aria-label={PARAM_LABELS[f.field]}
          bind:checked={() => Boolean(paramsAt(i)[f.field]), (v) => setField(i, f.field, v === true)}
        />
      </div>
    {:else if f.kind === 'select'}
      <Select.Root
        type="single"
        bind:value={() => String(paramsAt(i)[f.field]), (v) => setField(i, f.field, v)}
      >
        <Select.Trigger class="h-7 font-mono" aria-label={PARAM_LABELS[f.field]}>
          {String(paramsAt(i)[f.field])}
        </Select.Trigger>
        <Select.Content portalProps={portalProps()}>
          {#each f.options ?? [] as o (o)}
            <Select.Item value={o}>{o}</Select.Item>
          {/each}
        </Select.Content>
      </Select.Root>
    {:else}
      <Input
        type="number"
        min={bound?.min}
        max={bound?.max}
        step={bound?.step}
        aria-label={PARAM_LABELS[f.field]}
        bind:value={() => paramsAt(i)[f.field] as NumericInput, (v) => setField(i, f.field, v ?? '')}
        onblur={() => bound && clampField(i, f.field, bound)}
        disabled={locked}
        class="h-7 font-mono"
      />
    {/if}
  </div>
{/snippet}

{#snippet membershipLink()}
  {@const pricing = hostConfig().pricingUrl}
  {#if pricing}
    <a {...hostLink(pricing)} class="font-semibold text-primary hover:underline">View plans</a>
  {/if}
{/snippet}

<div class="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
  <div class="flex min-w-0 flex-col gap-5">
    <div>
      <h2 class="m-0 text-xl font-semibold text-white">Review &amp; start</h2>
      <p class="mt-1 text-sm text-dark-2">
        Steps are set to your model's recommended budget. Tweak if you like — everything else is
        optional.
      </p>
    </div>

    <div class="rounded-xl border border-dark-4 bg-dark-6 p-4">
      <label for="training-name" class="block text-sm font-semibold text-dark-0">Name your LoRA</label>
      <Input
        id="training-name"
        bind:value={name}
        placeholder="e.g. my_character — defaults to your trigger word"
        class="mt-2"
      />
      <p class="mt-1.5 text-xs text-dark-2">Shown as the run's title; you can rename it later.</p>
    </div>

    <div class="flex flex-wrap items-center justify-between gap-2">
      <div class="font-mono text-xs uppercase tracking-wider text-dark-2">Training runs</div>
      <div class="flex items-center gap-1.5">
        <span class="inline-flex items-center gap-1 font-mono text-xs text-dark-2">
          exposure guidance {@render help(GUIDANCE_HELP, 'exposure guidance')}
        </span>
        {#each presetTypes as t (t.id)}
          <Button
            variant={presetType === t.id ? 'default' : 'outline'}
            size="xs"
            onclick={() => setPreset(t.id)}
            title={`Recommended exposure for a ${t.name.toLowerCase()}: ~${seenFor(t.id, selection.media)}× per image`}
          >
            {t.name}
          </Button>
        {/each}
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
                {runVersionLabel(run)}{isCustom(run) ? ' · custom' : ''}
              </div>
              {#if noAdvancedParams(run)}
                <div class="mt-1 font-mono text-xs text-dark-2">
                  No advanced settings for this model
                </div>
              {:else}
                <button
                  type="button"
                  onclick={() => (openAdv = openAdv === i ? -1 : i)}
                  class="mt-1 inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-medium transition
                  {openAdv === i
                    ? 'border-primary/50 bg-primary/10 text-primary'
                    : 'border-dark-4 text-dark-2 hover:border-dark-3 hover:text-white'}"
                >
                  <IconSettings size={13} stroke={2} />Advanced settings
                  {#if advancedDeviationsAt(i).length > 0}
                    <span class="rounded bg-buzz/15 px-1 font-mono text-[10px] text-buzz">
                      {advancedDeviationsAt(i).length} changed
                    </span>
                  {/if}
                  {#if openAdv === i}<IconChevronUp size={12} stroke={2} />{:else}<IconChevronDown
                      size={12}
                      stroke={2}
                    />{/if}
                </button>
              {/if}
            </div>
            <div class="ml-auto flex flex-col">
              <span class="font-mono text-xs uppercase tracking-wider text-dark-2">Steps</span>
              <Input
                type="number"
                min={TARGET_STEPS.min}
                max={TARGET_STEPS.max}
                step={TARGET_STEPS.step}
                bind:value={() => paramsAt(i).steps || '', (v) => setSteps(i, String(v ?? ''))}
                onblur={() => clampSteps(i)}
                aria-invalid={stepsInvalid(i)}
                class="h-7 w-24 font-mono"
              />
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

          <div class="flex items-center gap-1 bg-dark-6 px-4 pb-3 font-mono text-xs {low(i) ? 'text-buzz' : 'text-emerald-400'}">
            {#if low(i)}<IconAlertTriangle size={13} stroke={2} class="shrink-0" />{:else}<IconCheck
                size={13}
                stroke={2}
                class="shrink-0"
              />{/if}each image seen ~{seen(i)}× ({low(i)
              ? `low — we recommend ~${presetSeen}×; results may be weak, no refund`
              : `good for a ${presetType}, target ~${presetSeen}×`})
          </div>

          {#if openAdv === i && !noAdvancedParams(run)}
            {@const extras = supportedExtras(i)}
            {@const hidden = unsupportedExtras(i)}
            <div class="border-t border-dark-4 bg-dark-8 px-4 py-4">
              <div class="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                <span class="inline-flex items-center gap-1 font-mono text-xs uppercase tracking-wider text-primary">
                  <IconSettings size={12} stroke={2} />Advanced training settings
                </span>
                <span class="font-mono text-xs text-dark-2">
                  seeded with {card.name}'s recommended values — hover (i) for what each does
                </span>
              </div>
              <div class="grid gap-x-6 sm:grid-cols-2">
                {#each CORE_FIELDS as f, k (f.field)}
                  {@render paramRow(i, f, extras.length === 0 && k === CORE_FIELDS.length - 1)}
                {/each}
                {#each extras as f, k (f.field)}
                  {@render paramRow(i, f, k === extras.length - 1)}
                {/each}
              </div>
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
      <div class="rounded-xl border border-dark-4 bg-dark-6 p-4">
        <div class="flex flex-col gap-2">
          {#each prompts as p, i (p.id)}
            {@const missing = triggerText !== '' && !promptHasTrigger(triggerText, p.text)}
            <div class="flex flex-col gap-1">
              <div class="flex items-center gap-2">
                <Input bind:value={prompts[i]!.text} aria-invalid={missing} class="flex-1" />
                {#if prompts.length > 1}
                  <Button variant="outline" size="icon-sm" aria-label={`Remove prompt ${i + 1}`} onclick={() => removePrompt(i)}><IconX size={14} stroke={2} /></Button>
                {/if}
              </div>
              {#if missing}
                <div class="flex flex-wrap items-center gap-x-1.5 font-mono text-[11px] text-buzz">
                  <IconAlertTriangle size={12} stroke={2} class="shrink-0" />
                  Missing your trigger word "{triggerText}" — this sample won't test it.
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
        {#if prompts.length < 6}
          <Button variant="outline" class="mt-2 w-full border-dashed" onclick={addPrompt}>+ Add sample prompt</Button>
        {/if}
        <p class="mt-2.5 font-mono text-xs text-dark-2">
          Applied to every run.
          {#if triggerText}
            Each sample starts with your trigger word "{triggerText}", so the images test what the
            LoRA is learning.
          {/if}
        </p>
      </div>
    </div>
  </div>

  <aside class="sticky top-4 h-fit max-h-[calc(100dvh-2rem)] overflow-y-auto rounded-xl border border-dark-4 bg-dark-6 p-5">
    <h3 class="m-0 mb-3 font-mono text-xs uppercase tracking-widest text-dark-2">What you're starting</h3>
    <dl class="m-0 flex flex-col gap-1 text-sm">
      <div class="flex justify-between gap-2.5">
        <dt class="text-dark-2">Type</dt>
        <dd class="m-0 font-semibold text-dark-0">{typeName} · {selection.media}</dd>
      </div>
      <div class="flex justify-between gap-2.5">
        <dt class="text-dark-2">Dataset</dt>
        <dd class="m-0 font-semibold text-dark-0">
          {mediaCount(imageCount, selection.media)} · {labelMode === 'tag' ? 'tags' : 'captions'}
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
          {prompts.length}{promptsMissingTrigger > 0 ? ` · ${promptsMissingTrigger} without trigger` : ''}
        </dd>
      </div>
    </dl>
    {#each selection.runs as run, i (run.id)}
      {@const devs = deviationsAt(i).filter((d) => d.field !== 'steps' && d.field !== 'epochs')}
      {@const p = paramsAt(i)}
      <div class="mt-2.5 border-t border-dark-4 pt-2.5 text-sm">
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
      ~{etaMin} min{multi ? ' · parallel' : ''} · {mediaCount(imageCount, selection.media)}
    </div>

    {#if blueExcluded}
      <div
        role="note"
        class="mt-3 flex items-start gap-2 rounded-lg border border-buzz/30 bg-buzz/5 p-3 text-xs leading-snug text-dark-1"
      >
        <IconAlertTriangle size={14} stroke={2} class="mt-px shrink-0 text-buzz" />
        <span>
          {matureCount}
          {matureCount === 1 ? 'image in your dataset was' : 'images in your dataset were'} rated
          <strong>mature</strong> (R or above) —
          <button type="button" onclick={onShowMature} class="font-semibold text-primary hover:underline">
            see which
          </button>.
          <span class="text-blue-400">Blue</span> Buzz can't pay for mature content without a
          membership, so {membership === undefined ? 'unless you have one, ' : ''}this
          {multi ? 'training' : 'run'} is charged in full in <span class="text-buzz">Yellow</span> Buzz.
          {@render membershipLink()}
        </span>
      </div>
    {:else}
      <BlueFirstNote class="mt-3" />
    {/if}

    {#if needsAttestation}
      <div
        class="mt-3 flex items-start gap-2 rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-3 text-[12px] leading-snug text-dark-1"
      >
        <Checkbox id="attest-sfw" bind:checked={attestSfw} class="mt-0.5 shrink-0" />
        <label for="attest-sfw" class="cursor-pointer">
          I confirm this training won't produce NSFW content.
          <span class="text-emerald-400">Green</span> (membership) Buzz can't be spent on NSFW training.
        </label>
      </div>
    {/if}

    <Button
      class="mt-4 w-full"
      onclick={start}
      disabled={starting || total == null || (needsAttestation && !attestSfw)}
    >
      {#if starting}
        <IconBoltFilled size={16} stroke={2} class="mr-1 inline" /> Starting…
      {:else}
        <IconBoltFilled size={16} stroke={2} class="mr-1 inline" />
        {multi ? `Start ${selection.runs.length} runs` : 'Start training'}
      {/if}
    </Button>
    {#if startError}
      <p class="mt-2 text-center font-mono text-xs text-red-400">{startError}</p>
    {:else if total == null && !quoting}
      <p class="mt-2 text-center font-mono text-xs text-dark-2">
        We couldn't price every run right now — start is disabled until each run shows a cost.
      </p>
    {/if}
    <p class="mt-3 text-center font-mono text-xs text-dark-2">
      Refunded automatically if training fails
    </p>
  </aside>
</div>

<div class="mt-6 flex items-center justify-between border-t border-dark-4 pt-5">
  <Button variant="outline" onclick={onBack}>
    <IconArrowLeft size={15} stroke={2} class="mr-1.5 inline" />Back
  </Button>
  <span class="font-mono text-xs text-dark-2">This is the only step that spends Buzz</span>
</div>

<Dialog.Root bind:open={spendDialogOpen}>
  <Dialog.Content class="sm:max-w-md" portalProps={portalProps()}>
    <Dialog.Header>
      <Dialog.Title>
        This {confirmSpend?.uncertain ? 'can spend' : 'spends'}
        {confirmSpend?.currency === 'green' ? 'Green' : 'Yellow'} Buzz
      </Dialog.Title>
      <Dialog.Description>
        {#if blueExcluded}
          Your dataset was rated mature, and
          <span class="text-blue-400">Blue</span> Buzz can't pay for mature content without a
          membership{membership === undefined ? ' — unless you have one, the' : '. The'} full
          <strong>{confirmSpend?.amount.toLocaleString()}</strong> will come out of your Yellow Buzz.
          {@render membershipLink()}
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
      </Dialog.Description>
    </Dialog.Header>
    <Dialog.Footer>
      <Dialog.Close>
        {#snippet child({ props })}
          <Button {...props} variant="ghost" size="sm">Cancel</Button>
        {/snippet}
      </Dialog.Close>
      <Button size="sm" onclick={() => void reallyStart()}>
        Spend {confirmSpend?.uncertain ? 'up to ' : ''}{confirmSpend?.amount.toLocaleString()}
        {confirmSpend?.currency === 'green' ? 'Green' : 'Yellow'} and start
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
