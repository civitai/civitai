<script lang="ts">
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import SelectStep from './SelectStep.svelte';
  import { runCard, runVersionLabel, type Selection } from './trainingFlow';

  let { onExit }: { onExit: () => void } = $props();

  const STEPS = [
    { n: 1, label: 'Select' },
    { n: 2, label: 'Data & labels' },
    { n: 3, label: 'Review & start' },
    { n: 4, label: 'Results' },
  ] as const;

  let step = $state(1);
  let selection = $state<Selection | null>(null);

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
      onContinue={(sel) => {
        selection = sel;
        step = 2;
      }}
    />
  {:else if selection}
    {@const name = STEPS.find((s) => s.n === step)?.label ?? ''}
    <div class="rounded-xl border border-dark-4 bg-dark-6 p-6">
      <div class="flex items-center gap-2">
        <h2 class="m-0 text-xl font-semibold text-white">{name}</h2>
        <span class="rounded-full bg-amber-500/15 px-2.5 py-1 font-mono text-[11px] font-semibold text-amber-400">
          in progress
        </span>
      </div>
      <p class="mt-1 text-sm text-dark-2">
        Next up in the build. See <code class="font-mono">docs/prototype/training-flow.html</code> for the
        design and <code class="font-mono">CLAUDE.md → Build order</code> for the plan.
      </p>

      <div class="mt-4 rounded-xl border border-dark-4 bg-dark-7 p-4">
        <div class="font-mono text-xs uppercase tracking-wider text-dark-2">Carried selection</div>
        <div class="mt-2 text-sm text-dark-0">Type: <strong>{selection.loraType}</strong></div>
        <ul class="mt-1 space-y-1 text-sm">
          {#each selection.runs as r, i (i)}
            {@const c = runCard(r)}
            <li class="text-dark-0">
              Run {i + 1}: <strong>{c.name}</strong>
              {runVersionLabel(r)}
              <span class="font-mono text-xs text-dark-2">({c.label === 'tag' ? 'tags' : 'captions'})</span>
            </li>
          {/each}
        </ul>
      </div>

      <Button variant="outline" class="mt-5" onclick={() => (step = step - 1)}>← Back</Button>
    </div>
  {/if}
</section>
