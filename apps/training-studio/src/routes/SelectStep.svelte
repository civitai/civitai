<script lang="ts">
  import {
    IconBoltFilled,
    IconStarFilled,
    IconCheck,
    IconStack2,
    IconMinus,
    IconPlus,
    IconX,
    IconArrowRight,
  } from '@tabler/icons-svelte';
  import { untrack } from 'svelte';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import {
    CUSTOM_MODEL_SURCHARGE,
    MEDIA_OPTIONS,
    cardByType,
    cardsForMedia,
    releasedLabel,
    typesForMedia,
    type Media,
    type ModelCard,
  } from '$lib/data/trainingModels';
  import {
    CUSTOM_VERSION_KEY,
    MAX_RUNS,
    cardFromPrice,
    isCustom,
    isValidAir,
    labelNoun,
    labelOptions,
    newRun,
    nextRunId,
    recommendedCardFor,
    runCard,
    runVersionLabel,
    selectionFromTotal,
    type Run,
    type Selection,
  } from './trainingFlow';

  let {
    onContinue,
    prices,
    initial = null,
  }: {
    onContinue: (sel: Selection) => void;
    prices: Record<string, number>;
    /** The selection to restore when re-entering this step (e.g. Back from Data) — the flow owns it, so a
     *  remount doesn't lose the chosen model(s). */
    initial?: Selection | null;
  } = $props();

  // The "from" price for a card — the single source of truth lives in trainingFlow so Select/Data/Review
  // can't drift. Null when the orchestrator hasn't quoted it (the caller shows a muted em-dash).
  function price(cardType: string, custom = false): number | null {
    return cardFromPrice(prices, cardType, custom);
  }

  // Seed from a restored selection (Back from Data) when present, else the defaults. untrack marks the
  // intentional one-time capture — the flow remounts this step, so a fresh mount re-seeds from the latest.
  let media = $state<Media>(untrack(() => initial?.media ?? 'image'));
  let loraType = $state<string>(untrack(() => initial?.loraType ?? 'character'));
  let runs = $state<Run[]>(
    untrack(() => (initial ? [...initial.runs] : [newRun(recommendedCardFor('character', 'image'))]))
  );
  let focus = $state(0);
  let sweepOpen = $state(untrack(() => (initial?.runs.length ?? 1) > 1));

  const types = $derived(typesForMedia(media));
  const type = $derived(types.find((t) => t.id === loraType) ?? types[0]!);
  const multi = $derived(runs.length > 1);
  const primary = $derived(runs[0]!);
  const focused = $derived(runs[focus] ?? primary);
  const selectedCard = $derived(runCard(focused));
  const recommendedType = $derived(type.recommended[media]);
  const recommendedCard = $derived(recommendedType ? cardByType(recommendedType) : undefined);
  // A tight, current set is featured up front; the long tail (older / niche models) sits behind a "show
  // more" toggle so the list isn't a wall of ~20 models. Audio has one card, so it shows everything.
  // `featuredCards` keeps the FEATURED order — the recommended model is first in it.
  const FEATURED: Partial<Record<Media, string[]>> = {
    image: ['zimage', 'anima', 'krea2'],
    video: ['minimaxh3', 'wan', 'ltx'],
  };
  const featuredCards = $derived.by(() => {
    const cards = cardsForMedia(media);
    const featured = FEATURED[media];
    if (!featured) return cards;
    return featured
      .map((t) => cards.find((c) => c.type === t))
      .filter((c): c is (typeof cards)[number] => c !== undefined);
  });
  const otherCards = $derived.by(() => {
    const featured = FEATURED[media];
    if (!featured) return [];
    const featuredSet = new Set(featured);
    return cardsForMedia(media).filter((c) => !featuredSet.has(c.type));
  });
  let showAllModels = $state(false);
  // Keep the tail open when the chosen model lives there, so the selection is never hidden.
  const selectedInOthers = $derived(otherCards.some((c) => c.type === focused.cardType));
  const modelsExpanded = $derived(showAllModels || selectedInOthers);
  const visibleCards = $derived(modelsExpanded ? [...featuredCards, ...otherCards] : featuredCards);
  const labelMode = $derived(runCard(primary).label);
  const labelModeNoun = $derived(labelNoun(runCard(primary)));
  // Partial when any selected run is unpriced — the summary shows "—" rather than a total missing a model.
  const total = $derived(selectionFromTotal(prices, runs));

  function pickMedia(m: Media) {
    if (m === media) return;
    media = m;
    // A dataset can't span media, so the MODEL always resets. The type carries over when the new media
    // offers it — switching Image→Video with Style chosen should stay Style, not silently become Character.
    const next = typesForMedia(m);
    const t = next.find((o) => o.id === loraType) ?? next[0]!;
    loraType = t.id;
    runs = [newRun(recommendedCardFor(t.id, m))];
    focus = 0;
    sweepOpen = false;
  }

  function pickType(id: string) {
    loraType = id;
    if (runs.length === 1) {
      runs = [newRun(recommendedCardFor(id, media))];
      focus = 0;
    }
  }

  function pickBase(card: ModelCard) {
    if (multi && !labelOptions(card).includes(labelMode)) return; // label-type lock
    runs = runs.map((r, i) => (i === focus ? { ...newRun(card), id: r.id } : r));
  }

  function openSweep() {
    sweepOpen = true;
    if (runs.length === 1) addRun();
  }

  function pickVersion(runIndex: number, versionKey: string) {
    runs = runs.map((r, i) => (i === runIndex ? { ...r, versionKey } : r));
  }
  function setCustomAir(runIndex: number, value: string) {
    runs = runs.map((r, i) => (i === runIndex ? { ...r, customAir: value } : r));
  }
  // A Custom run needs a valid pasted AIR before it can continue.
  const customIncomplete = $derived(runs.some((r) => isCustom(r) && !isValidAir(r.customAir ?? '')));

  function addRun() {
    if (runs.length >= MAX_RUNS) return;
    const src = runs[focus] ?? runs[0]!;
    runs = [...runs, { ...src, id: nextRunId() }];
    focus = runs.length - 1;
  }

  function removeRun(i: number) {
    if (runs.length <= 1) return;
    runs = runs.filter((_, k) => k !== i);
    // Keep focus on the same run: removing one before it shifts every later run down a slot.
    if (i < focus) focus -= 1;
    if (focus >= runs.length) focus = runs.length - 1;
    if (runs.length === 1) sweepOpen = false;
  }

  function versionsFor(card: ModelCard) {
    return [
      ...card.versions.map((v) => ({ key: v.key, label: v.label, surcharge: 0 })),
      { key: CUSTOM_VERSION_KEY, label: 'Custom', surcharge: CUSTOM_MODEL_SURCHARGE },
    ];
  }

  // Radiogroup arrow-key nav (media/type/base model): Tab enters at the checked radio (roving tabindex on
  // the buttons), arrows move focus AND selection to the next/prev ENABLED option. Reads the DOM so it
  // skips disabled (label-locked) tiles without index bookkeeping.
  function radioKeydown(e: KeyboardEvent) {
    const fwd = e.key === 'ArrowRight' || e.key === 'ArrowDown';
    const back = e.key === 'ArrowLeft' || e.key === 'ArrowUp';
    if (!fwd && !back) return;
    e.preventDefault();
    const radios = [
      ...(e.currentTarget as HTMLElement).querySelectorAll<HTMLButtonElement>('[role="radio"]'),
    ].filter((r) => !r.disabled);
    if (radios.length === 0) return;
    let i = radios.findIndex((r) => r === document.activeElement);
    if (i === -1) i = radios.findIndex((r) => r.getAttribute('aria-checked') === 'true');
    if (i === -1) i = 0;
    const target = radios[fwd ? (i + 1) % radios.length : (i - 1 + radios.length) % radios.length];
    target.focus();
    target.click();
  }
</script>

<!-- A "from" price with a bolt, or a muted em-dash when there's no quote — used by the run summaries. -->
{#snippet priceTag(amount: number | null, size: string)}
  {#if amount != null}
    <span class="whitespace-nowrap font-mono {size} text-buzz"
      >from <IconBoltFilled size={12} stroke={2} class="mb-px inline" />{amount.toLocaleString()}</span
    >
  {:else}
    <span class="whitespace-nowrap font-mono {size} text-dark-2">—</span>
  {/if}
{/snippet}

<!-- The Custom… base: paste a Civitai model AIR to train on (we don't have a model picker yet). -->
{#snippet customAirInput(run: Run, runIndex: number)}
  <div class="mt-2.5">
    <label
      for={`custom-air-${run.id}`}
      class="font-mono text-xs uppercase tracking-wider text-dark-2"
    >
      Civitai model AIR
    </label>
    <Input
      id={`custom-air-${run.id}`}
      value={run.customAir ?? ''}
      oninput={(e) => setCustomAir(runIndex, (e.currentTarget as HTMLInputElement).value)}
      placeholder="urn:air:sdxl:checkpoint:civitai:…@…"
      class="mt-1 font-mono text-xs"
    />
    <p class="mt-1 text-xs leading-snug text-dark-2">
      {#if run.customAir && !isValidAir(run.customAir)}
        <span class="text-buzz">Paste a full model AIR — it starts with <code>urn:air:</code>.</span>
      {:else}
        Paste the AIR of a Civitai model to train on (copy it from the model's page).
      {/if}
    </p>
  </div>
{/snippet}

<div class="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
  <div class="flex min-w-0 flex-col gap-6">
    <div>
      <h2 class="m-0 text-xl font-semibold text-white">What do you want to train?</h2>
      <p class="mt-1 text-sm text-dark-2">
        Pick what you're making — we'll recommend a base model and tune the settings later.
      </p>
    </div>

    <!-- Media + Type gate everything below (switching either resets the model), so they stay full
         labeled rows rather than a dropdown or a quiet segmented strip that would under-sell them. -->
    <div class="flex flex-col gap-3">
      <div class="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <div id="media-group-label" class="w-14 shrink-0 font-mono text-xs uppercase tracking-wider text-dark-2">
          Media
        </div>
        <div
          class="flex min-w-0 flex-1 flex-wrap gap-2"
          role="radiogroup"
          aria-labelledby="media-group-label"
          tabindex="-1"
          onkeydown={radioKeydown}
        >
          {#each MEDIA_OPTIONS as m (m.id)}
            <button
              type="button"
              role="radio"
              aria-checked={m.id === media}
              tabindex={m.id === media ? 0 : -1}
              onclick={() => pickMedia(m.id)}
              class="flex items-center gap-1.5 rounded-md border px-3.5 py-1.5 text-sm transition
                {m.id === media
                ? 'border-primary bg-primary/[0.07] ring-1 ring-primary/40 font-semibold text-white'
                : 'border-dark-4 bg-dark-6 font-medium text-dark-1 hover:border-dark-3 hover:text-dark-0'}"
            >
              {#if m.id === media}
                <span class="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" aria-hidden="true"></span>
              {/if}
              {m.name}
            </button>
          {/each}
        </div>
      </div>

      <div class="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <div id="type-group-label" class="w-14 shrink-0 font-mono text-xs uppercase tracking-wider text-dark-2">
          Type
        </div>
        <div
          class="flex min-w-0 flex-1 flex-wrap gap-2"
          role="radiogroup"
          aria-labelledby="type-group-label"
          tabindex="-1"
          onkeydown={radioKeydown}
        >
          {#each types as t (t.id)}
            <button
              type="button"
              role="radio"
              aria-checked={t.id === loraType}
              tabindex={t.id === loraType ? 0 : -1}
              onclick={() => pickType(t.id)}
              class="flex items-center gap-1.5 rounded-md border px-3.5 py-1.5 text-sm transition
                {t.id === loraType
                ? 'border-primary bg-primary/[0.07] ring-1 ring-primary/40 font-semibold text-white'
                : 'border-dark-4 bg-dark-6 font-medium text-dark-1 hover:border-dark-3 hover:text-dark-0'}"
            >
              {#if t.id === loraType}
                <span class="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" aria-hidden="true"></span>
              {/if}
              {t.name}
            </button>
          {/each}
        </div>
      </div>
    </div>

    <!-- base model: every model visible as an equal peer, recommended first; no disclosure -->
    <div>
      <div class="mb-1 flex items-baseline justify-between gap-2">
        <div class="font-mono text-xs uppercase tracking-wider text-dark-2">Base model</div>
        <div class="font-mono text-xs text-dark-2">
          {labelMode === 'tag' ? 'auto-labeled with tags' : 'auto-labeled with captions'}
        </div>
      </div>
      {#if recommendedCard}
        <p class="mb-3 text-[12.5px] leading-snug text-dark-1">
          <IconStarFilled size={12} class="mr-0.5 inline text-buzz" />
          We recommend <span class="font-semibold text-white">{recommendedCard.name}</span> for a
          {type.name.toLowerCase()}
          {media} LoRA — or pick any below.
        </p>
      {/if}

      <div
        class="grid grid-cols-2 gap-2 sm:grid-cols-3"
        role="radiogroup"
        aria-label="Base model"
        tabindex="-1"
        onkeydown={radioKeydown}
      >
        {#each visibleCards as card (card.type)}
          {@const selected = card.type === focused.cardType}
          {@const disabled = multi && !selected && !labelOptions(card).includes(labelMode)}
          {@const cardPrice = price(card.type)}
          <button
            type="button"
            role="radio"
            aria-checked={selected}
            tabindex={selected ? 0 : -1}
            {disabled}
            onclick={() => pickBase(card)}
            aria-label={`${card.name}. ${card.description} ${
              cardPrice != null ? `From ${cardPrice.toLocaleString()} Buzz.` : 'Price not available.'
            } ${card.flag ? `${card.flag}. ` : ''}${
              card.versions.length > 1 ? `${card.versions.length} versions. ` : ''
            }${disabled ? `Unavailable — uses ${labelNoun(card)}, your sweep uses ${labelModeNoun}.` : ''}`}
            title={disabled
              ? `${card.name} uses ${labelNoun(card)}; your other run uses ${labelModeNoun}. One dataset can't mix — remove the other run to switch.`
              : undefined}
            class="group relative flex flex-col rounded-md border p-3 text-left transition
              {selected
              ? 'border-primary bg-primary/[0.07] ring-1 ring-primary/40'
              : 'border-dark-4 bg-dark-6 hover:border-dark-3 hover:bg-dark-5'}
              {disabled ? 'cursor-not-allowed opacity-40 grayscale' : ''}"
          >
            <div class="flex items-center gap-2">
              <div class="min-w-0 flex-1">
                <div class="truncate text-sm font-semibold text-dark-0">{card.name}</div>
              </div>
              {#if card.flag}
                <span class="inline-flex shrink-0 items-center gap-0.5 rounded bg-primary px-1.5 py-0.5 font-mono text-xs font-bold uppercase tracking-wide text-primary-foreground">
                  {#if card.flag === 'recommended'}<IconStarFilled size={8} />{/if}{card.flag}
                </span>
              {/if}
              {#if selected}
                <span class="grid h-4 w-4 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground">
                  <IconCheck size={11} stroke={3} />
                </span>
              {/if}
            </div>
            <div class="mt-1 line-clamp-1 text-xs leading-snug text-dark-2">
              {card.description}
            </div>
            <div class="mt-2 flex items-center gap-2">
              {#if cardPrice != null}
                <span
                  class="inline-flex items-center whitespace-nowrap rounded border border-buzz/25 bg-buzz/[0.08] px-1.5 py-0.5 font-mono text-xs font-semibold text-buzz"
                >
                  from <IconBoltFilled size={11} stroke={2} class="mx-px inline" />{cardPrice.toLocaleString()}
                </span>
              {:else}
                <span class="font-mono text-xs text-dark-2">—</span>
              {/if}
              {#if releasedLabel(card.released)}
                <span class="font-mono text-xs text-dark-2">{releasedLabel(card.released)}</span>
              {/if}
              {#if card.versions.length > 1}
                <span
                  aria-hidden="true"
                  title={`${card.versions.length} versions`}
                  class="ml-auto inline-flex items-center gap-0.5 rounded-sm border border-dark-4 px-1 py-px font-mono text-xs leading-none text-dark-2"
                >
                  <IconStack2 size={10} stroke={2} />
                  {card.versions.length}
                </span>
              {/if}
            </div>
          </button>
        {/each}
      </div>

      {#if otherCards.length > 0}
        <button
          type="button"
          onclick={() => (showAllModels = !showAllModels)}
          class="mt-2 flex w-full items-center justify-center gap-1 rounded-md border border-dashed border-dark-4 py-2 font-mono text-xs text-dark-2 transition-colors hover:border-dark-3 hover:text-dark-1"
        >
          {#if modelsExpanded}
            <IconMinus size={12} stroke={2} />Show fewer models
          {:else}
            <IconPlus size={12} stroke={2} />Show {otherCards.length} more model{otherCards.length ===
            1
              ? ''
              : 's'} ({otherCards
              .slice(0, 3)
              .map((c) => c.name)
              .join(', ')}…)
          {/if}
        </button>
      {/if}

      <!-- version choice for the single selected model, inline (no disclosure) -->
      {#if !multi}
        {@const card = selectedCard}
        {@const runPrice = price(primary.cardType, isCustom(primary))}
        <div class="mt-3 rounded-md border border-dark-4 bg-dark-6 p-3">
          <div class="flex items-center gap-3">
            <div class="min-w-0">
              <div class="truncate text-sm font-bold text-dark-0">
                {card.name}
                {runVersionLabel(primary)}
              </div>
              <div class="font-mono text-xs text-dark-2">
                {labelNoun(card)}{#if isCustom(primary)} · custom (+<IconBoltFilled
                    size={10}
                    stroke={2}
                    class="inline"
                  />{CUSTOM_MODEL_SURCHARGE}){/if}
              </div>
            </div>
            <div class="ml-auto">{@render priceTag(runPrice, 'text-[13px]')}</div>
          </div>
          {#if versionsFor(card).length > 1}
            <div class="mt-3 font-mono text-xs uppercase tracking-wider text-dark-2">Version</div>
            <div
              class="mt-1.5 flex flex-wrap gap-2"
              role="radiogroup"
              aria-label={`${card.name} version`}
            >
              {#each versionsFor(card) as v (v.key)}
                <button
                  type="button"
                  role="radio"
                  aria-checked={primary.versionKey === v.key}
                  onclick={() => pickVersion(0, v.key)}
                  class="rounded border px-3 py-1.5 text-left transition
                    {primary.versionKey === v.key
                    ? 'border-primary bg-primary/10'
                    : 'border-dark-4 bg-dark-7 hover:border-dark-3'}
                    {v.key === CUSTOM_VERSION_KEY ? 'border-dashed' : ''}"
                >
                  <div class="flex items-center gap-2">
                    <span class="text-[12.5px] font-bold text-dark-0">{v.label}</span>
                    {#if v.surcharge}
                      <span
                        class="inline-flex rounded bg-buzz/15 px-1.5 py-0.5 font-mono text-xs font-semibold text-buzz"
                      >
                        +<IconBoltFilled size={10} stroke={2} class="inline" />{v.surcharge.toLocaleString()}
                      </span>
                    {/if}
                  </div>
                </button>
              {/each}
            </div>
          {/if}
          {#if isCustom(primary)}
            {@render customAirInput(primary, 0)}
          {/if}
        </div>
      {/if}
    </div>

    <!-- multi-run sweep (advanced): train several models / versions at once -->
    <div class="rounded-xl border border-dark-4 bg-dark-6/40">
      {#if !sweepOpen && !multi}
        <button
          type="button"
          onclick={openSweep}
          class="flex w-full items-center justify-between gap-2 px-3.5 py-2.5 text-left transition hover:bg-dark-6"
        >
          <span class="inline-flex items-center gap-1 text-sm font-semibold text-dark-1">
            <IconPlus size={14} stroke={2} />Train an additional model
          </span>
          <span class="font-mono text-xs text-dark-2">same dataset · another model or settings</span>
        </button>
      {:else}
        <div class="flex flex-col gap-2.5 p-3.5">
          <div class="font-mono text-xs uppercase tracking-wider text-dark-2">
            Training runs <span class="lowercase text-dark-2">· {runs.length} models · pick a tile above to change the highlighted run</span>
          </div>
          {#each runs as r, ri (r.id)}
            {@const card = runCard(r)}
            {@const focusedRow = ri === focus}
            {@const runPrice = price(r.cardType, isCustom(r))}
            <div
              class="rounded-md border p-3 transition
                {focusedRow ? 'border-primary ring-2 ring-primary/30' : 'border-dark-4 bg-dark-6'}"
            >
              <div class="flex items-center gap-3">
                <button
                  type="button"
                  aria-pressed={focusedRow}
                  onclick={() => (focus = ri)}
                  class="flex min-w-0 flex-1 items-center gap-3 text-left"
                >
                  <div class="min-w-0">
                    <div class="truncate text-sm font-bold text-dark-0">
                      Run {ri + 1} · {card.name}
                      {runVersionLabel(r)}
                    </div>
                    <div class="font-mono text-xs text-dark-2">
                      {labelNoun(card)}{#if isCustom(r)} · custom (+<IconBoltFilled
                          size={10}
                          stroke={2}
                          class="inline"
                        />{CUSTOM_MODEL_SURCHARGE}){/if}{focusedRow ? ' · editing' : ''}
                    </div>
                  </div>
                </button>
                <div class="ml-auto shrink-0">{@render priceTag(runPrice, 'text-[13px]')}</div>
                {#if multi}
                  <button
                    type="button"
                    aria-label={`Remove run ${ri + 1}`}
                    onclick={() => removeRun(ri)}
                    class="grid h-7 w-7 shrink-0 place-items-center rounded border border-dark-4 text-dark-2 hover:border-red-500 hover:text-red-400"
                  >
                    <IconX size={14} stroke={2} />
                  </button>
                {/if}
              </div>
              <div class="mt-2.5 flex flex-wrap gap-2" role="radiogroup" aria-label={`Run ${ri + 1} version`}>
                {#each versionsFor(card) as v (v.key)}
                  <button
                    type="button"
                    role="radio"
                    aria-checked={r.versionKey === v.key}
                    onclick={() => pickVersion(ri, v.key)}
                    class="rounded border px-3 py-1.5 text-left transition
                      {r.versionKey === v.key
                      ? 'border-primary bg-primary/10'
                      : 'border-dark-4 bg-dark-7 hover:border-dark-3'}
                      {v.key === CUSTOM_VERSION_KEY ? 'border-dashed' : ''}"
                  >
                    <div class="flex items-center gap-2">
                      <span class="text-[12.5px] font-bold text-dark-0">{v.label}</span>
                      {#if v.surcharge}
                        <span
                          class="inline-flex rounded bg-buzz/15 px-1.5 py-0.5 font-mono text-xs font-semibold text-buzz"
                        >
                          +<IconBoltFilled size={10} stroke={2} class="inline" />{v.surcharge.toLocaleString()}
                        </span>
                      {/if}
                    </div>
                  </button>
                {/each}
              </div>
              {#if isCustom(r)}
                {@render customAirInput(r, ri)}
              {/if}
            </div>
          {/each}
          <button
            type="button"
            disabled={runs.length >= MAX_RUNS}
            onclick={addRun}
            class="w-full rounded-md border border-dashed border-dark-4 py-2.5 text-sm font-semibold text-dark-2 transition hover:border-primary hover:text-primary disabled:opacity-40"
          >
            + Add another model to train
          </button>
        </div>
      {/if}
    </div>
  </div>

  <!-- summary -->
  <div class="sticky top-4 h-fit">
  <aside class="max-h-[calc(100dvh-2rem)] overflow-y-auto rounded-xl border border-dark-4 bg-dark-6 p-5">
    <h3 class="m-0 mb-3 font-mono text-xs uppercase tracking-widest text-dark-2">Your training</h3>
    <div class="flex justify-between gap-2.5 border-b border-dark-4 py-2 text-sm">
      <span class="text-dark-2">Media</span><span class="font-semibold capitalize text-dark-0">{media}</span>
    </div>
    <div class="flex justify-between gap-2.5 border-b border-dark-4 py-2 text-sm">
      <span class="text-dark-2">Type</span><span class="font-semibold text-dark-0">{type.name}</span>
    </div>
    {#if multi}
      <div class="flex justify-between gap-2.5 border-b border-dark-4 py-2 text-sm">
        <span class="text-dark-2">Models</span><span class="font-semibold text-dark-0">{runs.length}</span>
      </div>
    {/if}
    <div class="flex justify-between gap-2.5 py-2 text-sm">
      <span class="text-dark-2">Labeling</span>
      <span class="font-semibold text-dark-0">{labelMode === 'tag' ? 'Tags' : 'Captions'}</span>
    </div>
    <div class="mt-1.5 flex items-baseline justify-between border-t border-dark-4 pt-3.5">
      <span class="text-sm font-semibold text-white">Starting at</span>
      {#if total != null}
        <span class="font-mono text-2xl font-bold text-buzz">
          <IconBoltFilled size={20} stroke={2} class="mb-0.5 inline" /> {total.toLocaleString()}
        </span>
      {:else}
        <span class="font-mono text-2xl font-bold text-dark-2">—</span>
      {/if}
    </div>
    <div class="mt-1 text-right font-mono text-xs text-dark-2">
      price depends on data and settings
    </div>
    <Button
      class="mt-4 h-11 w-full"
      disabled={customIncomplete}
      onclick={() => onContinue({ media, loraType, runs })}
    >
      Continue to data<IconArrowRight size={15} stroke={2} class="ml-1.5 inline" />
    </Button>
    {#if customIncomplete}
      <p class="mt-1.5 text-center font-mono text-xs text-buzz">
        Paste a Civitai model AIR for the custom base to continue.
      </p>
    {/if}
  </aside>
  <p
    class="mt-3 flex items-center justify-center gap-1.5 whitespace-nowrap font-mono text-xs text-dark-2"
  >
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="var(--color-buzz)"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      class="h-3 w-3 shrink-0"
      aria-hidden="true"
    >
      <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </svg>
    Nothing is saved until you start training
  </p>
  </div>
</div>
