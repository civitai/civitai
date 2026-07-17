<script lang="ts" generics="T extends number | null | undefined">
  import type { HTMLInputAttributes } from 'svelte/elements';
  import { Input } from '@civitai/ui/components/ui/input/index.js';

  // Studio number input: whole-number guard + snap-to-max on top of the shared shadcn Input.
  // Generic + bindable so it drops into both `bind:value` editor forms and one-way / form-submit
  // fields; clamping runs against the bound value so it survives conditional re-renders.
  type Props = Omit<HTMLInputAttributes, 'type' | 'min' | 'max' | 'value' | 'files'> & {
    value?: T;
    min?: number;
    max?: number;
    /** Whole numbers only — block non-digit input and set step=1 (default true). */
    integer?: boolean;
    /** Snap the value down to `max` as soon as it's exceeded (default true). */
    clamp?: boolean;
  };

  let {
    value = $bindable(),
    min,
    max,
    integer = true,
    clamp = true,
    class: className,
    ...rest
  }: Props = $props();

  function handleBeforeInput(e: InputEvent) {
    if (!integer) return;
    const text = e.data ?? e.dataTransfer?.getData('text') ?? '';
    if (text && /\D/.test(text)) e.preventDefault();
  }

  function handleInput() {
    if (clamp && max != null && typeof value === 'number' && value > max) value = max as T;
  }
</script>

<Input
  {...rest}
  type="number"
  {min}
  {max}
  step={integer ? 1 : undefined}
  inputmode={integer ? 'numeric' : undefined}
  onbeforeinput={handleBeforeInput}
  oninput={handleInput}
  bind:value
  class={className}
/>
