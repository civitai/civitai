<script lang="ts">
  import { untrack } from 'svelte';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import * as Select from '@civitai/ui/components/ui/select/index.js';
  import { loraTypeById, typesForMedia, type FromPrices } from '$lib/data/trainingModels';
  import ModelCodeBadge from '$lib/components/ModelCodeBadge.svelte';
  import {
    isCustom,
    runCard,
    runCost,
    runVersionLabel,
    type LaunchedRun,
    type RunParams,
    type Selection,
  } from './trainingFlow';

  let {
    selection,
    prices,
    imageCount,
    labels,
    trigger,
    onStart,
    onBack,
  }: {
    selection: Selection;
    prices: FromPrices;
    imageCount: number;
    /** The dataset's per-image labels (joined tags / captions) — the sample prompts seed from these. */
    labels: string[];
    /** The chosen trigger word, if any — pre-fills the name field (the run is named after it by default). */
    trigger: string;
    onStart: (
      launched: LaunchedRun[],
      prompts: string[],
      name: string,
      currencies: string[]
    ) => Promise<void>;
    onBack: () => void;
  } = $props();

  // Pre-fill the name with the trigger word (the run defaults to it anyway); the parent remounts this step
  // via {#if}, so this one-time seed is correct. The user can still overwrite it.
  let name = $state(untrack(() => trigger.trim()));
  let starting = $state(false);
  let startError = $state('');

  // Which Buzz accounts to charge, in priority order. Yellow (purchased) + blue (generation) by default —
  // the prior fixed behavior; the user can add/remove Green. The submit filters/defaults this server-side.
  const BUZZ_OPTIONS = [
    { key: 'yellow', label: 'Yellow', hint: 'purchased' },
    { key: 'blue', label: 'Blue', hint: 'generation' },
    { key: 'green', label: 'Green', hint: 'membership' },
  ] as const;
  let currencies = $state<string[]>(['yellow', 'blue']);
  function toggleCurrency(key: string) {
    if (currencies.includes(key)) {
      if (currencies.length > 1) currencies = currencies.filter((c) => c !== key); // keep ≥1
    } else {
      // re-derive in BUZZ_OPTIONS order so the array stays a stable priority list
      currencies = BUZZ_OPTIONS.map((o) => o.key).filter((k) => k === key || currencies.includes(k));
    }
  }

  const SAMPLE_RATE = 30;
  const OPTIMIZERS = ['AdamW8Bit', 'Adafactor', 'Prodigy', 'Automagic'];
  // ai-toolkit's supported set — no `cosine_with_restarts` (the orchestrator rejects it).
  const LR_SCHEDULERS = ['cosine', 'constant', 'constant_with_warmup', 'linear'];

  const presetTypes = $derived(typesForMedia(selection.media));
  const seenFor = (id: string) => loraTypeById(id).seen;
  const defaultSteps = (id: string) => Math.max(200, imageCount * seenFor(id));

  // Seeded once from the (stable) selection; the parent remounts this step via {#if}, so a fresh
  // selection gets a fresh component. untrack documents the intentional one-time capture.
  let presetType = $state(untrack(() => selection.loraType));
  let params = $state<RunParams[]>(
    untrack(() =>
      selection.runs.map(() => ({
        steps: defaultSteps(selection.loraType),
        epochs: 10,
        unetLr: '0.0004',
        textEncoderLr: '0.00005',
        networkDim: '32',
        networkAlpha: '16',
        lrScheduler: 'cosine',
        optimizer: 'AdamW8Bit',
        resolution: '1024',
        batchSize: '2',
      })),
    ),
  );
  let stepsEdited = $state<boolean[]>(untrack(() => selection.runs.map(() => false)));
  // Seed the sample prompts from the dataset itself — 3 random image labels (joined tags or the caption) —
  // so the test images generated during training reflect what the model actually learned. Falls back to a
  // generic prompt when the dataset carries no usable labels.
  function seedPrompts(source: string[]): { id: number; text: string }[] {
    const pool = source.map((l) => l.trim()).filter((l) => l.length > 0);
    const picks: string[] = [];
    while (picks.length < 3 && pool.length > 0) {
      picks.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]!);
    }
    const chosen = picks.length > 0 ? picks : ['a photo'];
    return chosen.map((text, id) => ({ id, text }));
  }
  const initialPrompts = untrack(() => seedPrompts(labels));
  let prompts = $state(initialPrompts);
  let promptSeq = initialPrompts.length;
  let openAdv = $state(-1);

  const presetSeen = $derived(seenFor(presetType));
  const sampleCost = $derived(prompts.length * SAMPLE_RATE);
  // Per-run cost from the model's live quote; `null` for any run the orchestrator couldn't price, which
  // makes the whole total `null` (shown as "—") rather than a total quietly missing a run.
  const runCostAt = (i: number) =>
    runCost(prices[selection.runs[i]!.cardType], selection.runs[i]!, params[i]!.steps);
  const runTotal = $derived.by(() => {
    let sum = 0;
    for (let i = 0; i < selection.runs.length; i++) {
      const cost = runCostAt(i);
      if (cost == null) return null;
      sum += cost;
    }
    return sum;
  });
  const total = $derived(runTotal == null ? null : runTotal + sampleCost);
  const runCostLabel = (i: number) => {
    const cost = runCostAt(i);
    return cost == null ? '—' : `⚡ ${cost.toLocaleString()}`;
  };
  const etaMin = $derived(
    Math.max(...selection.runs.map((_, i) => Math.max(1, Math.round((params[i]!.steps / 2000) * 18)))),
  );

  function seen(i: number) {
    return imageCount > 0 ? Math.round(params[i]!.steps / imageCount) : 0;
  }
  function low(i: number) {
    return seen(i) < Math.round(presetSeen * 0.6);
  }

  function setPreset(id: string) {
    presetType = id;
    params = params.map((p, i) => (stepsEdited[i] ? p : { ...p, steps: defaultSteps(id) }));
  }
  function setSteps(i: number, v: string) {
    params[i]!.steps = parseInt(v) || 0;
    stepsEdited[i] = true;
  }
  function addPrompt() {
    if (prompts.length < 6) prompts = [...prompts, { id: promptSeq++, text: 'new scene' }];
  }
  function removePrompt(i: number) {
    if (prompts.length > 1) prompts = prompts.filter((_, k) => k !== i);
  }
  async function start() {
    if (starting) return;
    starting = true;
    startError = '';
    try {
      await onStart(
        selection.runs.map((run, i) => ({ run, params: params[i]! })),
        prompts.map((p) => p.text),
        name,
        currencies
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
        Steps are set for you from your type and image count. Tweak if you like — everything else is
        optional.
      </p>
    </div>

    <div class="rounded-md border border-dark-4 bg-dark-6 p-4">
      <label for="training-name" class="block text-sm font-semibold text-dark-0">Name your LoRA</label>
      <Input
        id="training-name"
        bind:value={name}
        placeholder="e.g. my_character — defaults to your trigger word"
        class="mt-2"
      />
      <p class="mt-1.5 text-[11px] text-dark-2">Shown as the run's title; you can rename it later.</p>
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
        <div class="overflow-hidden rounded-md border border-dark-4">
          <div class="flex flex-wrap items-center gap-3 bg-dark-6 px-4 py-3">
            <ModelCodeBadge code={card.code} size="sm" />
            <div>
              <div class="text-sm font-bold text-dark-0">
                {multi ? `Run ${i + 1} · ` : ''}{card.name}
                {runVersionLabel(run)}{isCustom(run) ? ' · custom' : ''}
              </div>
              <button
                type="button"
                onclick={() => (openAdv = openAdv === i ? -1 : i)}
                class="mt-1 inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-medium transition
                  {openAdv === i
                  ? 'border-primary/50 bg-primary/10 text-primary'
                  : 'border-dark-4 text-dark-2 hover:border-dark-3 hover:text-white'}"
              >
                ⚙ Advanced settings <span class="text-[10px]">{openAdv === i ? '▲' : '▼'}</span>
              </button>
            </div>
            <div class="ml-auto flex flex-col">
              <span class="font-mono text-[10px] uppercase tracking-wider text-dark-2">Steps</span>
              <Input
                value={String(params[i]!.steps)}
                oninput={(e) => setSteps(i, e.currentTarget.value)}
                class="h-7 w-24 font-mono"
              />
            </div>
            <span class="w-20 text-right font-mono text-sm text-[#f59f00]">
              {runCostLabel(i)}
            </span>
          </div>

          <div class="bg-dark-6 px-4 pb-3 font-mono text-xs {low(i) ? 'text-[#f59f00]' : 'text-emerald-400'}">
            {low(i) ? '⚠️ ' : '✓ '}each image seen ~{seen(i)}× ({low(i)
              ? `low — we recommend ~${presetSeen}×; results may be weak, no refund`
              : `good for a ${presetType}`})
          </div>

          {#if openAdv === i}
            <div class="border-t border-dark-4 bg-dark-8 px-4 py-4">
              <div class="mb-2 font-mono text-[11px] uppercase tracking-wider text-primary">
                ⚙ Advanced training settings
              </div>
              <div class="grid gap-x-6 sm:grid-cols-2">
                <div class="grid grid-cols-[1fr_120px] items-center gap-2 border-b border-dark-4/60 py-1.5 text-sm">
                  <span class="text-dark-2">Checkpoints (epochs)</span>
                  <Input value={String(params[i]!.epochs)} oninput={(e) => (params[i]!.epochs = parseInt(e.currentTarget.value) || 0)} class="h-7 font-mono" />
                </div>
                <div class="grid grid-cols-[1fr_120px] items-center gap-2 border-b border-dark-4/60 py-1.5 text-sm">
                  <span class="text-dark-2">Batch size</span>
                  <Input bind:value={params[i]!.batchSize} class="h-7 font-mono" />
                </div>
                <div class="grid grid-cols-[1fr_120px] items-center gap-2 border-b border-dark-4/60 py-1.5 text-sm">
                  <span class="text-dark-2">UNet LR</span>
                  <Input bind:value={params[i]!.unetLr} class="h-7 font-mono" />
                </div>
                <div class="grid grid-cols-[1fr_120px] items-center gap-2 border-b border-dark-4/60 py-1.5 text-sm">
                  <span class="text-dark-2">Text encoder LR</span>
                  <Input bind:value={params[i]!.textEncoderLr} class="h-7 font-mono" />
                </div>
                <div class="grid grid-cols-[1fr_120px] items-center gap-2 border-b border-dark-4/60 py-1.5 text-sm">
                  <span class="text-dark-2">Network dim</span>
                  <Input bind:value={params[i]!.networkDim} class="h-7 font-mono" />
                </div>
                <div class="grid grid-cols-[1fr_120px] items-center gap-2 border-b border-dark-4/60 py-1.5 text-sm">
                  <span class="text-dark-2">Network alpha</span>
                  <Input bind:value={params[i]!.networkAlpha} class="h-7 font-mono" />
                </div>
                <div class="grid grid-cols-[1fr_120px] items-center gap-2 border-b border-dark-4/60 py-1.5 text-sm">
                  <span class="text-dark-2">Resolution</span>
                  <Input bind:value={params[i]!.resolution} class="h-7 font-mono" />
                </div>
                <div class="grid grid-cols-[1fr_120px] items-center gap-2 border-b border-dark-4/60 py-1.5 text-sm">
                  <span class="text-dark-2">LR scheduler</span>
                  <Select.Root type="single" bind:value={params[i]!.lrScheduler}>
                    <Select.Trigger class="h-7 font-mono">{params[i]!.lrScheduler}</Select.Trigger>
                    <Select.Content>
                      {#each LR_SCHEDULERS as s (s)}
                        <Select.Item value={s}>{s}</Select.Item>
                      {/each}
                    </Select.Content>
                  </Select.Root>
                </div>
                <div class="grid grid-cols-[1fr_120px] items-center gap-2 py-1.5 text-sm">
                  <span class="text-dark-2">Optimizer</span>
                  <Select.Root type="single" bind:value={params[i]!.optimizer}>
                    <Select.Trigger class="h-7 font-mono">{params[i]!.optimizer}</Select.Trigger>
                    <Select.Content>
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
      <div class="rounded-md border border-dark-4 bg-dark-6 p-4">
        <div class="flex flex-col gap-2">
          {#each prompts as p, i (p.id)}
            <div class="flex items-center gap-2">
              <Input bind:value={prompts[i]!.text} class="flex-1" />
              {#if prompts.length > 1}
                <Button variant="outline" size="icon-sm" aria-label={`Remove prompt ${i + 1}`} onclick={() => removePrompt(i)}>✕</Button>
              {/if}
            </div>
          {/each}
        </div>
        {#if prompts.length < 6}
          <Button variant="outline" class="mt-2 w-full border-dashed" onclick={addPrompt}>+ Add sample prompt</Button>
        {/if}
        <p class="mt-2.5 font-mono text-[11px] text-dark-2">
          Applied to every run. Extra prompts add a small per-image charge.
        </p>
      </div>
    </div>
  </div>

  <aside class="sticky top-4 h-fit max-h-[calc(100dvh-2rem)] overflow-y-auto rounded-md border border-dark-4 bg-dark-6 p-5">
    <h3 class="m-0 mb-3 font-mono text-xs uppercase tracking-widest text-dark-2">Final price</h3>
    {#each selection.runs as run, i (run.id)}
      <div class="flex justify-between gap-2.5 border-b border-dark-4 py-2 text-sm">
        <span class="truncate text-dark-2">{multi ? `Run ${i + 1} · ` : ''}{runCard(run).name}</span>
        <span class="font-semibold text-dark-0">{runCostLabel(i)}</span>
      </div>
    {/each}
    <div class="flex justify-between gap-2.5 py-2 text-sm">
      <span class="text-dark-2">Sample images</span>
      <span class="font-semibold text-dark-0">⚡ {sampleCost.toLocaleString()}</span>
    </div>
    <div class="mt-2 flex items-baseline justify-between border-t border-dark-4 pt-3.5">
      <span class="text-sm text-dark-2">Total</span>
      <span class="font-mono text-2xl font-bold text-[#f59f00]">
        {total == null ? '—' : `⚡ ${total.toLocaleString()}`}
      </span>
    </div>
    <div class="mt-1 text-right font-mono text-[11px] text-dark-2">
      ~{etaMin} min{multi ? ' · parallel' : ''} · {imageCount} image{imageCount === 1 ? '' : 's'}
    </div>

    <div class="mt-4 border-t border-dark-4 pt-3.5">
      <div class="mb-1.5 font-mono text-[10px] uppercase tracking-wider text-dark-2">Pay with</div>
      <div class="flex flex-wrap gap-1.5">
        {#each BUZZ_OPTIONS as opt (opt.key)}
          {@const on = currencies.includes(opt.key)}
          <button
            type="button"
            aria-pressed={on}
            onclick={() => toggleCurrency(opt.key)}
            class="rounded border px-2 py-1 text-left transition-colors {on
              ? 'border-[#f59f00]/40 bg-[#f59f00]/10'
              : 'border-dark-4 bg-dark-7 hover:border-dark-3'}"
          >
            <span class="text-[12px] font-semibold {on ? 'text-[#f59f00]' : 'text-dark-1'}">
              ⚡ {opt.label}
            </span>
            <span class="ml-1 font-mono text-[10px] text-dark-2">{opt.hint}</span>
          </button>
        {/each}
      </div>
      <p class="mt-1.5 font-mono text-[10px] text-dark-2">Charged in this order until covered.</p>
    </div>

    <Button class="mt-4 w-full" onclick={start} disabled={starting}>
      {#if starting}
        ⚡ Starting…
      {:else}
        ⚡ {multi ? `Start ${selection.runs.length} runs` : 'Start training'}
      {/if}
    </Button>
    {#if startError}
      <p class="mt-2 text-center font-mono text-[11px] text-red-400">{startError}</p>
    {/if}
    <p class="mt-3 text-center font-mono text-[11px] text-dark-2">
      Refunded automatically if training fails
    </p>
  </aside>
</div>

<div class="mt-6 flex items-center justify-between border-t border-dark-4 pt-5">
  <Button variant="outline" onclick={onBack}>← Back</Button>
  <span class="font-mono text-xs text-dark-2">This is the one moment we submit to the orchestrator</span>
</div>
