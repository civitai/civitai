<script lang="ts">
  import { onMount } from 'svelte';
  import { IconCheck, IconArrowLeft } from '@tabler/icons-svelte';
  import { goto } from '$app/navigation';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import SelectStep from './SelectStep.svelte';
  import DataStep from './DataStep.svelte';
  import ReviewStep from './ReviewStep.svelte';
  import {
    buildTrainingRuns,
    isTrainable,
    labelString,
    runCard,
    type Img,
    type LaunchedRun,
    type Selection,
  } from './trainingFlow';
  import { postTraining } from '$lib/train';
  import type { FromPrices } from '$lib/data/trainingModels';

  let { prices, onExit }: { prices: FromPrices; onExit: () => void } = $props();

  const STEPS = [
    { n: 1, label: 'Select' },
    { n: 2, label: 'Data & labels' },
    { n: 3, label: 'Review & start' },
  ] as const;

  let step = $state(1);
  let selection = $state<Selection | null>(null);
  // Dataset + trigger are owned here so they survive Back/Continue between steps.
  let images = $state<Img[]>([]);
  let trigger = $state('');

  // A "Train again with this data" hand-off from a run's detail page: reuse its blob airs (already
  // uploaded + scanned) rather than re-uploading. Read once, then cleared so a refresh doesn't re-import.
  // DataStep materializes these once a model is picked (the label type depends on the selection).
  let reuseItems = $state<{ air: string; caption: string; name: string; previewUrl: string }[]>([]);
  onMount(() => {
    try {
      const raw = sessionStorage.getItem('ts:reuse-dataset');
      if (raw) {
        reuseItems = JSON.parse(raw);
        sessionStorage.removeItem('ts:reuse-dataset');
      }
    } catch {
      // Malformed hand-off — ignore and start empty.
    }
  });
  // Only successfully uploaded + scanned images train — blocked / in-flight tiles don't count.
  const trainableCount = $derived(images.filter(isTrainable).length);

  // The dataset's own labels (joined tags or captions) — Review seeds its sample prompts from these.
  const datasetLabels = $derived.by(() => {
    if (!selection) return [];
    const mode = runCard(selection.runs[0]!).label;
    return images
      .filter(isTrainable)
      .map((i) => labelString(i, mode))
      .filter((l) => l.length > 0);
  });

  // Free the dataset preview object URLs when the flow unmounts (leaving to My-trainings). Reads
  // nothing reactive, so it's mount-only — not per-step; images and their previews live here and must
  // survive Back/Continue, so DataStep must not do this on its own unmount.
  $effect(() => () => {
    for (const img of images) URL.revokeObjectURL(img.previewUrl);
  });

  function jump(n: number) {
    if (n <= step) step = n;
  }

  // The one write in the whole flow: assemble each run and submit real workflow(s), then land on the run
  // to watch it live — a single run opens its detail, a sweep goes to the list. Errors propagate to
  // ReviewStep, which shows them on the Start button.
  async function start(
    launched: LaunchedRun[],
    prompts: string[],
    name: string,
    currencies: string[]
  ) {
    if (!selection) return;
    const runs = buildTrainingRuns(selection, images, trigger, name, launched, prompts, currencies);
    const ids = await postTraining(runs);
    // A single run opens its detail; a sweep (or a partial submit) goes to the list, where every run that
    // landed appears — so a partial failure never re-submits the successful, already-charged runs.
    await goto(runs.length === 1 && ids[0] ? `/${ids[0]}` : '/', { invalidateAll: true });
  }
</script>

<section class="flex flex-col gap-6">
  <div class="flex items-center justify-between gap-3">
    <nav class="flex flex-wrap items-center gap-1.5" aria-label="Training steps">
      {#each STEPS as s, i (s.n)}
        {@const state = s.n < step ? 'done' : s.n === step ? 'active' : 'todo'}
        <div class="flex items-center gap-1.5">
          <button
            type="button"
            onclick={() => jump(s.n)}
            class="flex items-center gap-2 transition {state === 'todo' ? 'opacity-50' : 'opacity-100'}"
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
            <span class="text-sm font-semibold {state === 'active' ? 'text-dark-0' : 'text-dark-2'}">
              {s.label}
            </span>
          </button>
          {#if i < STEPS.length - 1}
            <span class="h-px w-8 bg-dark-4"></span>
          {/if}
        </div>
      {/each}
    </nav>
    <Button variant="outline" size="sm" onclick={onExit}>
      <IconArrowLeft size={15} stroke={2} class="mr-1.5 inline" />Exit
    </Button>
  </div>

  {#if step === 1}
    <SelectStep
      {prices}
      initial={selection}
      onContinue={(sel) => {
        selection = sel;
        step = 2;
      }}
    />
  {:else if step === 2 && selection}
    <DataStep
      {selection}
      {prices}
      {reuseItems}
      bind:images
      bind:trigger
      onContinue={() => (step = 3)}
      onBack={() => (step = 1)}
    />
  {:else if step === 3 && selection}
    <ReviewStep
      {selection}
      {prices}
      {trigger}
      imageCount={trainableCount}
      labels={datasetLabels}
      onStart={start}
      onBack={() => (step = 2)}
    />
  {/if}
</section>
