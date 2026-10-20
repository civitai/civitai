<script lang="ts">
  import { STEPS, type FlowStep } from './steps';

  let { step = $bindable(), problems }: { step: FlowStep; problems: number } = $props();
</script>

<nav class="mb-4 flex border-b border-dark-4" aria-label="Steps">
  {#each STEPS as [key, label], i (key)}
    <button
      type="button"
      class="flex min-w-0 flex-1 items-center justify-center gap-1.5 border-b-2 px-1 pt-2 pb-2.5 text-sm {step === key ? 'border-blue-5 text-white' : 'border-transparent text-dark-2 hover:text-white'}"
      aria-current={step === key ? 'step' : undefined}
      onclick={() => (step = key)}
    >
      <span class="grid size-[18px] flex-none place-items-center rounded-full text-[11px] {step === key ? 'bg-blue-5 text-white' : 'bg-dark-5'}">{i + 1}</span>
      <span class="truncate">{label}</span>
      {#if key === 'publish' && problems}
        <span class="size-2 flex-none rounded-full bg-red-400" aria-hidden="true"></span><span class="sr-only">{problems} to fix</span>
      {/if}
    </button>
  {/each}
</nav>
