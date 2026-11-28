<script module lang="ts">
  export { violationInputs };
</script>

<script lang="ts">
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import * as Select from '@civitai/ui/components/ui/select/index.js';
  import { VIOLATION_LABELS, VIOLATION_TYPES } from '$lib/violations';
  import type { ViolationGate } from './violation-gate.svelte';

  let { gate }: { gate: ViolationGate } = $props();
</script>

{#snippet violationInputs(gate: ViolationGate)}
  <input type="hidden" name="violationType" value={gate.type} />
  <input type="hidden" name="violationDetails" value={gate.note} />
{/snippet}

<Select.Root type="single" bind:value={gate.type}>
  <Select.Trigger
    bind:ref={gate.select}
    aria-label="Violation type"
    class="h-[30px] w-[140px] flex-none justify-between border-dark-4 bg-dark-7 text-[13px] text-dark-0 dark:bg-dark-7"
  >
    <span class="truncate">
      {gate.type ? VIOLATION_LABELS[gate.type as keyof typeof VIOLATION_LABELS] : 'Violation type'}
    </span>
  </Select.Trigger>
  <Select.Content>
    {#each VIOLATION_TYPES as v (v)}
      <Select.Item value={v} label={VIOLATION_LABELS[v]}>{VIOLATION_LABELS[v]}</Select.Item>
    {/each}
  </Select.Content>
</Select.Root>
<Input
  bind:value={gate.note}
  maxlength={1000}
  aria-label="Note for the owner"
  placeholder="Note for the owner (optional)"
  class="h-[30px] min-w-0 flex-1 basis-0 border-dark-4 bg-dark-7 text-[13px] placeholder:text-dark-2 dark:bg-dark-7"
/>
