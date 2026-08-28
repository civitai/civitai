<script lang="ts">
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import {
    CUSTOM_MODEL_SURCHARGE,
    LORA_TYPES,
    cardsForMedia,
    type ModelCard,
  } from '$lib/data/trainingModels';
  import {
    CUSTOM_VERSION_KEY,
    MAX_RUNS,
    isCustom,
    newRun,
    recCard,
    runCard,
    runVersionLabel,
    startPrice,
    type Run,
    type Selection,
  } from './trainingFlow';

  let { onContinue }: { onContinue: (sel: Selection) => void } = $props();

  let loraType = $state('character');
  let runs = $state<Run[]>([newRun(recCard('character'))]);
  let focus = $state(0);

  const type = $derived(LORA_TYPES.find((t) => t.id === loraType) ?? LORA_TYPES[0]!);
  const cards = $derived(cardsForMedia(type.media));
  const multi = $derived(runs.length > 1);
  const primary = $derived(runs[0]!);
  const focused = $derived(runs[focus] ?? primary);
  const labelMode = $derived(runCard(primary).label);
  const total = $derived(runs.reduce((s, r) => s + startPrice(r.cardType, isCustom(r)), 0));

  function pickType(id: string) {
    const next = LORA_TYPES.find((t) => t.id === id) ?? LORA_TYPES[0]!;
    const mediaChanged = next.media !== type.media;
    loraType = id;
    // Reset the selection for a single run, or whenever the media changes (image ⇄ video) —
    // a dataset can't span media, so the old runs won't apply.
    if (runs.length === 1 || mediaChanged) {
      runs = [newRun(recCard(id))];
      focus = 0;
    }
  }

  function pickBase(card: ModelCard) {
    if (multi && card.label !== labelMode) return; // label-type lock
    runs = runs.map((r, i) => (i === focus ? newRun(card) : r));
  }

  function pickVersion(runIndex: number, versionKey: string) {
    runs = runs.map((r, i) => (i === runIndex ? { ...r, versionKey } : r));
  }

  function addRun() {
    if (runs.length >= MAX_RUNS) return;
    const src = runs[focus] ?? runs[0]!;
    runs = [...runs, { ...src }];
    focus = runs.length - 1;
  }

  function removeRun(i: number) {
    if (runs.length <= 1) return;
    runs = runs.filter((_, k) => k !== i);
    if (focus >= runs.length) focus = runs.length - 1;
  }

  function versionsFor(card: ModelCard) {
    return [
      ...card.versions.map((v) => ({ key: v.key, label: v.label, note: v.note })),
      { key: CUSTOM_VERSION_KEY, label: 'Custom…', note: `+⚡${CUSTOM_MODEL_SURCHARGE} · pick a model` },
    ];
  }
</script>

<div class="grid gap-6 lg:grid-cols-[1fr_320px]">
  <div class="flex flex-col gap-6">
    <div>
      <h2 class="m-0 text-xl font-semibold text-white">What do you want to train?</h2>
      <p class="mt-1 text-sm text-dark-2">
        Pick what you're making — we'll recommend a base model and tune the settings later.
      </p>
    </div>

    <!-- type tiles -->
    <div class="grid grid-cols-4 gap-2.5" role="radiogroup" aria-label="LoRA type">
      {#each LORA_TYPES as t (t.id)}
        <button
          type="button"
          role="radio"
          aria-checked={t.id === loraType}
          onclick={() => pickType(t.id)}
          class="flex flex-col items-center gap-1.5 rounded-xl border px-2 py-3.5 text-sm font-semibold transition
            {t.id === loraType
            ? 'border-primary bg-primary/10 text-white'
            : 'border-dark-4 bg-dark-6 text-dark-2 hover:border-dark-3 hover:text-dark-0'}"
        >
          <span class="text-2xl">{t.icon}</span>
          {t.name}
        </button>
      {/each}
    </div>

    <!-- base model cards, filtered to the type's media -->
    <div>
      <div class="mb-2 font-mono text-xs uppercase tracking-wider text-dark-2">
        Base model · {type.media} · recommended is pre-selected
      </div>
      <div class="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {#each cards as card (card.type)}
          {@const selected = card.type === focused.cardType}
          {@const disabled = multi && !selected && card.label !== labelMode}
          {@const rec = card.type === type.rec}
          <button
            type="button"
            {disabled}
            onclick={() => !disabled && pickBase(card)}
            title={disabled
              ? `${card.name} uses ${card.label === 'tag' ? 'tags' : 'captions'}; your other run uses ${labelMode === 'tag' ? 'tags' : 'captions'}. One dataset can't mix — remove the other run to switch.`
              : undefined}
            class="group relative overflow-hidden rounded-xl border bg-dark-6 text-left transition
              {selected ? 'border-primary ring-2 ring-primary/40' : 'border-dark-4 hover:border-dark-3'}
              {disabled ? 'opacity-40 grayscale' : 'hover:-translate-y-0.5'}"
          >
            {#if rec}
              <span
                class="absolute left-2 top-2 z-10 rounded bg-primary px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase text-primary-foreground"
              >
                Rec
              </span>
            {/if}
            {#if selected}
              <span
                class="absolute right-2 top-2 z-10 grid h-5 w-5 place-items-center rounded-full bg-primary font-mono text-xs font-bold text-primary-foreground"
              >
                ✓
              </span>
            {/if}
            <div class="grid h-16 place-items-center bg-dark-7 font-mono text-lg font-extrabold text-dark-2">
              {card.code}
            </div>
            <div class="p-3">
              <div class="text-sm font-bold text-dark-0">{card.name}</div>
              <div class="mt-0.5 line-clamp-2 min-h-[32px] text-[11px] leading-snug text-dark-2">
                {card.description}
              </div>
              <div class="mt-2 flex flex-wrap items-center gap-1.5">
                <span class="rounded border border-amber-500/30 px-1.5 py-0.5 font-mono text-[9px] text-amber-400">
                  from ⚡{startPrice(card.type).toLocaleString()}
                </span>
                <span class="rounded bg-primary/10 px-1.5 py-0.5 font-mono text-[9px] text-primary">
                  {card.label === 'tag' ? 'tags' : 'captions'}
                </span>
                {#if card.versions.length > 1}
                  <span class="rounded bg-dark-7 px-1.5 py-0.5 font-mono text-[9px] text-dark-2">
                    {card.versions.length} versions
                  </span>
                {/if}
              </div>
            </div>
          </button>
        {/each}
      </div>
    </div>

    <!-- selected runs + versions -->
    <div>
      <div class="mb-2 font-mono text-xs uppercase tracking-wider text-dark-2">
        Selected to train
        <span class="lowercase text-dark-3">
          {multi ? `· ${runs.length} models` : '· pick one, or add more to sweep (advanced)'}
        </span>
      </div>
      <div class="flex flex-col gap-2.5">
        {#each runs as r, ri (ri)}
          {@const card = runCard(r)}
          {@const focusedRow = ri === focus && multi}
          <div
            role="button"
            tabindex="0"
            onclick={() => (focus = ri)}
            onkeydown={(e) => (e.key === 'Enter' || e.key === ' ') && (focus = ri)}
            class="rounded-xl border p-3 transition
              {focusedRow ? 'border-primary ring-2 ring-primary/30' : 'border-dark-4 bg-dark-6'}
              {multi ? '' : 'cursor-default'}"
          >
            <div class="flex items-center gap-3">
              <div
                class="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-primary/10 font-mono text-[10px] font-extrabold text-primary"
              >
                {card.code}
              </div>
              <div class="min-w-0">
                <div class="truncate text-sm font-bold text-dark-0">
                  {multi ? `Run ${ri + 1} · ` : ''}{card.name}
                  {runVersionLabel(r)}
                </div>
                <div class="font-mono text-[11px] text-dark-2">
                  {card.label === 'tag' ? 'tags' : 'captions'}{isCustom(r)
                    ? ` · custom (+⚡${CUSTOM_MODEL_SURCHARGE})`
                    : ''}{focusedRow ? ' · editing' : ''}
                </div>
              </div>
              <span class="ml-auto whitespace-nowrap font-mono text-[13px] text-amber-400">
                from ⚡{startPrice(r.cardType, isCustom(r)).toLocaleString()}
              </span>
              {#if multi}
                <button
                  type="button"
                  aria-label={`Remove run ${ri + 1}`}
                  onclick={(e) => {
                    e.stopPropagation();
                    removeRun(ri);
                  }}
                  class="grid h-7 w-7 place-items-center rounded-lg border border-dark-4 text-dark-2 hover:border-red-500 hover:text-red-400"
                >
                  ✕
                </button>
              {/if}
            </div>
            <div class="mt-2.5 flex flex-wrap gap-2">
              {#each versionsFor(card) as v (v.key)}
                <button
                  type="button"
                  onclick={(e) => {
                    e.stopPropagation();
                    pickVersion(ri, v.key);
                  }}
                  class="rounded-lg border px-3 py-1.5 text-left transition
                    {r.versionKey === v.key
                    ? 'border-primary bg-primary/10'
                    : 'border-dark-4 bg-dark-7 hover:border-dark-3'}
                    {v.key === CUSTOM_VERSION_KEY ? 'border-dashed' : ''}"
                >
                  <div class="text-[12.5px] font-bold text-dark-0">{v.label}</div>
                  {#if v.note}
                    <div class="font-mono text-[10px] text-dark-2">{v.note}</div>
                  {/if}
                </button>
              {/each}
            </div>
          </div>
        {/each}
      </div>
      <button
        type="button"
        disabled={runs.length >= MAX_RUNS}
        onclick={addRun}
        class="mt-2.5 w-full rounded-xl border border-dashed border-dark-4 py-2.5 text-sm font-semibold text-dark-2 transition hover:border-primary hover:text-primary disabled:opacity-40"
      >
        + Add another model to train (advanced)
      </button>
    </div>
  </div>

  <!-- summary -->
  <aside class="sticky top-4 h-fit rounded-xl border border-dark-4 bg-dark-6 p-5">
    <h3 class="m-0 mb-3 font-mono text-xs uppercase tracking-widest text-dark-2">Your training</h3>
    <div class="flex justify-between gap-2.5 border-b border-dark-4 py-2 text-sm">
      <span class="text-dark-2">Type</span><span class="font-semibold text-dark-0">{type.name}</span>
    </div>
    <div class="flex justify-between gap-2.5 border-b border-dark-4 py-2 text-sm">
      <span class="text-dark-2">Models</span><span class="font-semibold text-dark-0">{runs.length}</span>
    </div>
    <div class="flex justify-between gap-2.5 py-2 text-sm">
      <span class="text-dark-2">Labeling</span>
      <span class="font-semibold text-dark-0">{labelMode === 'tag' ? 'Tags' : 'Captions'}</span>
    </div>
    <div class="mt-3.5 flex items-baseline justify-between border-t border-dark-4 pt-3.5">
      <span class="text-sm text-dark-2">Starting at</span>
      <span class="font-mono text-2xl font-bold text-amber-400">⚡ {total.toLocaleString()}</span>
    </div>
    <div class="mt-1 text-right font-mono text-[11px] text-dark-2">
      final price after your data &amp; settings
    </div>
    <Button class="mt-4 w-full" onclick={() => onContinue({ loraType, runs })}>Continue to Data →</Button>
    <p class="mt-3 text-center font-mono text-[11px] text-dark-2">
      🔒 Nothing is saved until you start training
    </p>
  </aside>
</div>
