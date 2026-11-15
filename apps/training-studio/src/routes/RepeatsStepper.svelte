<script lang="ts">
  import { IconMinus, IconPlus } from '@tabler/icons-svelte';
  import { MAX_REPEATS } from '$lib/repeats';
  import { clampRepeats } from './trainingFlow';

  let { value = $bindable(1), label }: { value: number; label: string } = $props();
</script>

<div class="inline-flex items-center rounded-md border border-dark-4 bg-dark-7">
  <button
    type="button"
    aria-label="Fewer repeats"
    disabled={value <= 1}
    onclick={() => (value = clampRepeats(value - 1))}
    class="grid h-7 w-7 place-items-center text-dark-2 hover:text-white disabled:opacity-40"
  >
    <IconMinus size={12} stroke={2} />
  </button>
  <input
    type="number"
    min="1"
    max={MAX_REPEATS}
    aria-label={label}
    value={value}
    onchange={(e) => {
      value = clampRepeats(e.currentTarget.valueAsNumber);
      // When the clamped number equals the stored one, `value` doesn't change and Svelte leaves the
      // typed text (25, 0, 3.4) in the box.
      e.currentTarget.value = String(value);
    }}
    class="h-7 w-10 bg-transparent text-center font-mono text-xs text-dark-0 [appearance:textfield] focus:outline-none [&::-webkit-inner-spin-button]:appearance-none"
  />
  <button
    type="button"
    aria-label="More repeats"
    disabled={value >= MAX_REPEATS}
    onclick={() => (value = clampRepeats(value + 1))}
    class="grid h-7 w-7 place-items-center text-dark-2 hover:text-white disabled:opacity-40"
  >
    <IconPlus size={12} stroke={2} />
  </button>
</div>
