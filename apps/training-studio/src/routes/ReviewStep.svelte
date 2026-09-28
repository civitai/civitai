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
  } from '@tabler/icons-svelte';
  import { buzzMode } from '$lib/buzz-mode.svelte';
  import { nonBlueSpend } from '$lib/buzz-balance.svelte';
  import BlueFirstNote from '$lib/components/BlueFirstNote.svelte';
  import { backend, portalProps } from '$lib/host';
  import { debouncedQuote } from '$lib/debounced-quote.svelte';
  import * as Dialog from '@civitai/ui/components/ui/dialog/index.js';
  import * as Tooltip from '@civitai/ui/components/ui/tooltip/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Checkbox } from '@civitai/ui/components/ui/checkbox/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import * as Select from '@civitai/ui/components/ui/select/index.js';
  import {
    mediaCount,
    paramBounds,
    seenFor,
    TARGET_STEPS,
    TE_TRAINING_UNSUPPORTED,
    typesForMedia,
    type ParamBound,
  } from '$lib/data/trainingModels';
  import {
    isCustom,
    runCard,
    runParamsKey,
    runVersion,
    runVersionLabel,
    type LaunchedRun,
    type Run,
    type RunParams,
    type SamplePrompt,
    type Selection,
  } from './trainingFlow';

  // name / prompts / params / presetType are owned and seeded by the flow so they survive Back.
  let {
    selection,
    name = $bindable(),
    prompts = $bindable(),
    params = $bindable(),
    presetType = $bindable(),
    imageCount,
    onStart,
    onBack,
  }: {
    selection: Selection;
    name: string;
    prompts: SamplePrompt[];
    /** Keyed by `runParamsKey`; the flow guarantees an entry for every run in `selection`. */
    params: Record<string, RunParams>;
    presetType: string;
    imageCount: number;
    onStart: (
      launched: LaunchedRun[],
      prompts: string[],
      name: string,
      currencies: string[]
    ) => Promise<void>;
    onBack: () => void;
  } = $props();

  let starting = $state(false);
  let startError = $state('');

  // Green (membership) Buzz can't pay for NSFW training, so spending it requires an explicit attestation.
  let attestSfw = $state(false);
  const needsAttestation = $derived(buzzMode.value === 'green');
  $effect(() => {
    if (!needsAttestation) attestSfw = false;
  });


  const OPTIMIZERS = ['AdamW8Bit', 'Adafactor', 'Prodigy', 'Automagic'];
  // ai-toolkit's supported set — no `cosine_with_restarts` (the orchestrator rejects it).
  const LR_SCHEDULERS = ['cosine', 'constant', 'constant_with_warmup', 'linear'];

  const presetTypes = $derived(typesForMedia(selection.media));

  const paramsAt = (i: number): RunParams => params[runParamsKey(selection.runs[i]!)]!;
  let openAdv = $state(-1);

  const presetSeen = $derived(seenFor(presetType, selection.media));

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

  // Only the "seen ~N×" guidance follows the preset now — step defaults are fixed per base model.
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

  type NumField = 'unetLr' | 'textEncoderLr' | 'networkDim' | 'networkAlpha' | 'resolution' | 'batchSize';
  // Clamp a numeric string field into the model's [min, max] on blur, so a user can't submit out-of-range.
  function clampField(i: number, field: NumField, bound: ParamBound) {
    const p = paramsAt(i);
    const n = Number(p[field]);
    if (!Number.isFinite(n)) return;
    const clamped = Math.min(bound.max, Math.max(bound.min, n));
    if (String(clamped) !== p[field]) p[field] = String(clamped);
  }
  function setEpochs(i: number, v: string) {
    const b = boundsFor(i).epochs;
    const n = parseInt(v);
    paramsAt(i).epochs = Number.isFinite(n) ? Math.min(b.max, Math.max(b.min, n)) : b.min;
  }
  function addPrompt() {
    const id = Math.max(-1, ...prompts.map((p) => p.id)) + 1;
    if (prompts.length < 6) prompts = [...prompts, { id, text: 'new scene' }];
  }
  function removePrompt(i: number) {
    if (prompts.length > 1) prompts = prompts.filter((_, k) => k !== i);
  }
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
    const spend = nonBlueSpend(total, buzzMode.value);
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

    <div class="flex items-center justify-between">
      <div class="font-mono text-xs uppercase tracking-wider text-dark-2">Training runs</div>
      <div class="flex items-center gap-1.5">
        <span class="font-mono text-xs text-dark-2">preset</span>
        {#each presetTypes as t (t.id)}
          <Button
            variant={presetType === t.id ? 'default' : 'outline'}
            size="xs"
            onclick={() => setPreset(t.id)}
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
              : `good for a ${presetType}`})
          </div>

          {#if openAdv === i && !noAdvancedParams(run)}
            {@const b = boundsFor(i)}
            {@const teLocked = TE_TRAINING_UNSUPPORTED.has(selection.runs[i]!.versionKey)}
            <div class="border-t border-dark-4 bg-dark-8 px-4 py-4">
              <div class="mb-2 flex items-center gap-1 font-mono text-xs uppercase tracking-wider text-primary">
                <IconSettings size={12} stroke={2} />Advanced training settings
              </div>
              <div class="grid gap-x-6 sm:grid-cols-2">
                <div class="grid grid-cols-[1fr_120px] items-center gap-2 border-b border-dark-4/60 py-1.5 text-sm">
                  <span class="text-dark-2">Checkpoints (epochs)</span>
                  <Input type="number" min={b.epochs.min} max={b.epochs.max} step={b.epochs.step} value={String(paramsAt(i).epochs)} oninput={(e) => setEpochs(i, e.currentTarget.value)} class="h-7 font-mono" />
                </div>
                <div class="grid grid-cols-[1fr_120px] items-center gap-2 border-b border-dark-4/60 py-1.5 text-sm">
                  <span class="text-dark-2">Batch size</span>
                  <Input type="number" min={b.batchSize.min} max={b.batchSize.max} step={b.batchSize.step} bind:value={params[runParamsKey(run)]!.batchSize} onblur={() => clampField(i, 'batchSize', b.batchSize)} class="h-7 font-mono" />
                </div>
                <div class="grid grid-cols-[1fr_120px] items-center gap-2 border-b border-dark-4/60 py-1.5 text-sm">
                  <span class="text-dark-2">UNet LR</span>
                  <Input type="number" min={b.unetLr.min} max={b.unetLr.max} step={b.unetLr.step} bind:value={params[runParamsKey(run)]!.unetLr} onblur={() => clampField(i, 'unetLr', b.unetLr)} class="h-7 font-mono" />
                </div>
                <div class="grid grid-cols-[1fr_120px] items-center gap-2 border-b border-dark-4/60 py-1.5 text-sm">
                  <span class="text-dark-2">
                    Text encoder LR{#if teLocked}<Tooltip.Provider>
                        <Tooltip.Root>
                          <Tooltip.Trigger class="ml-1 text-dark-2">(unavailable)</Tooltip.Trigger>
                          <Tooltip.Content class="max-w-[240px] text-xs" portalProps={portalProps()}>
                            This model cannot train its text encoder — runs fail and hang.
                          </Tooltip.Content>
                        </Tooltip.Root>
                      </Tooltip.Provider>{/if}
                  </span>
                  <Input type="number" min={b.textEncoderLr.min} max={b.textEncoderLr.max} step={b.textEncoderLr.step} bind:value={params[runParamsKey(run)]!.textEncoderLr} onblur={() => clampField(i, 'textEncoderLr', b.textEncoderLr)} disabled={teLocked} class="h-7 font-mono" />
                </div>
                <div class="grid grid-cols-[1fr_120px] items-center gap-2 border-b border-dark-4/60 py-1.5 text-sm">
                  <span class="text-dark-2">Network dim</span>
                  <Input type="number" min={b.networkDim.min} max={b.networkDim.max} step={b.networkDim.step} bind:value={params[runParamsKey(run)]!.networkDim} onblur={() => clampField(i, 'networkDim', b.networkDim)} class="h-7 font-mono" />
                </div>
                <div class="grid grid-cols-[1fr_120px] items-center gap-2 border-b border-dark-4/60 py-1.5 text-sm">
                  <span class="text-dark-2">Network alpha</span>
                  <Input type="number" min={b.networkAlpha.min} max={b.networkAlpha.max} step={b.networkAlpha.step} bind:value={params[runParamsKey(run)]!.networkAlpha} onblur={() => clampField(i, 'networkAlpha', b.networkAlpha)} class="h-7 font-mono" />
                </div>
                <div class="grid grid-cols-[1fr_120px] items-center gap-2 border-b border-dark-4/60 py-1.5 text-sm">
                  <span class="text-dark-2">Resolution</span>
                  <Input type="number" min={b.resolution.min} max={b.resolution.max} step={b.resolution.step} bind:value={params[runParamsKey(run)]!.resolution} onblur={() => clampField(i, 'resolution', b.resolution)} class="h-7 font-mono" />
                </div>
                <div class="grid grid-cols-[1fr_120px] items-center gap-2 border-b border-dark-4/60 py-1.5 text-sm">
                  <span class="text-dark-2">LR scheduler</span>
                  <Select.Root type="single" bind:value={params[runParamsKey(run)]!.lrScheduler}>
                    <Select.Trigger class="h-7 font-mono">{paramsAt(i).lrScheduler}</Select.Trigger>
                    <Select.Content portalProps={portalProps()}>
                      {#each LR_SCHEDULERS as s (s)}
                        <Select.Item value={s}>{s}</Select.Item>
                      {/each}
                    </Select.Content>
                  </Select.Root>
                </div>
                <div class="grid grid-cols-[1fr_120px] items-center gap-2 py-1.5 text-sm">
                  <span class="text-dark-2">Optimizer</span>
                  <Select.Root type="single" bind:value={params[runParamsKey(run)]!.optimizer}>
                    <Select.Trigger class="h-7 font-mono">{paramsAt(i).optimizer}</Select.Trigger>
                    <Select.Content portalProps={portalProps()}>
                      {#each OPTIMIZERS as o (o)}
                        <Select.Item value={o}>{o}</Select.Item>
                      {/each}
                    </Select.Content>
                  </Select.Root>
                </div>
              </div>
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
            <div class="flex items-center gap-2">
              <Input bind:value={prompts[i]!.text} class="flex-1" />
              {#if prompts.length > 1}
                <Button variant="outline" size="icon-sm" aria-label={`Remove prompt ${i + 1}`} onclick={() => removePrompt(i)}><IconX size={14} stroke={2} /></Button>
              {/if}
            </div>
          {/each}
        </div>
        {#if prompts.length < 6}
          <Button variant="outline" class="mt-2 w-full border-dashed" onclick={addPrompt}>+ Add sample prompt</Button>
        {/if}
        <p class="mt-2.5 font-mono text-xs text-dark-2">Applied to every run.</p>
      </div>
    </div>
  </div>

  <aside class="sticky top-4 h-fit max-h-[calc(100dvh-2rem)] overflow-y-auto rounded-xl border border-dark-4 bg-dark-6 p-5">
    <h3 class="m-0 mb-3 font-mono text-xs uppercase tracking-widest text-dark-2">Final price</h3>
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

    <BlueFirstNote class="mt-3" />

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
        {#if confirmSpend?.uncertain}
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
