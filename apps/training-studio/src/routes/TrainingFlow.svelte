<script lang="ts">
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import SelectStep from './SelectStep.svelte';
  import DataStep from './DataStep.svelte';
  import ReviewStep from './ReviewStep.svelte';
  import ResultsStep from './ResultsStep.svelte';
  import type { Img, LaunchedRun, Selection } from './trainingFlow';
  import type { FromPrices } from '$lib/data/trainingModels';

  let { prices, onExit }: { prices: FromPrices; onExit: () => void } = $props();

  const STEPS = [
    { n: 1, label: 'Select' },
    { n: 2, label: 'Data & labels' },
    { n: 3, label: 'Review & start' },
    { n: 4, label: 'Results' },
  ] as const;

  let step = $state(1);
  let selection = $state<Selection | null>(null);
  // Dataset + trigger are owned here so they survive Back/Continue between steps.
  let images = $state<Img[]>([]);
  let trigger = $state('');
  let launched = $state<LaunchedRun[] | null>(null);

  function jump(n: number) {
    if (n <= step) step = n;
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
              {state === 'done' ? '✓' : s.n}
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
    <Button variant="outline" size="sm" onclick={onExit}>☰ My trainings</Button>
  </div>

  {#if step === 1}
    <SelectStep
      {prices}
      onContinue={(sel) => {
        selection = sel;
        step = 2;
      }}
    />
  {:else if step === 2 && selection}
    <DataStep {selection} bind:images bind:trigger onContinue={() => (step = 3)} onBack={() => (step = 1)} />
  {:else if step === 3 && selection}
    <ReviewStep
      {selection}
      {prices}
      imageCount={images.length}
      onStart={(l) => {
        launched = l;
        step = 4;
      }}
      onBack={() => (step = 2)}
    />
  {:else if step === 4 && launched}
    <ResultsStep {launched} {trigger} onExit={onExit} />
  {/if}
</section>
