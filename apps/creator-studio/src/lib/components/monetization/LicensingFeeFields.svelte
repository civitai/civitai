<script lang="ts">
  import * as Select from '@civitai/ui/components/ui/select/index.js';
  import NumberInput from '$lib/components/NumberInput.svelte';
  import { feeMaxFor } from '$lib/monetization/fee';
  import type { MonetizationLimits, CapTier } from '@civitai/buzz';

  // The buzz-per-N-generations pair, shared by the per-version sidebar and the bulk dialog.
  //
  // `suggested` is optional — bulk only knows it when a type filter pins one model type.
  let {
    buzz = $bindable(),
    images = $bindable(),
    limits,
    suggested,
    ariaLabelSuffix = '',
  }: {
    buzz: number | undefined;
    images: string;
    limits: MonetizationLimits;
    suggested?: { buzz: number; images: number };
    ariaLabelSuffix?: string;
  } = $props();

  // The same ceiling for every creator; only the version's media type moves it.
  const ceiling = $derived(feeMaxFor(limits, Number(images)));
</script>

<div class="flex flex-wrap items-center gap-1.5">
  <NumberInput
    name="buzz"
    min={0}
    max={ceiling}
    bind:value={buzz}
    placeholder="Off"
    aria-label="Buzz{ariaLabelSuffix}"
    class="w-16 py-1"
  />
  <span class="text-xs text-dark-2">⚡ per</span>
  <input type="hidden" name="images" value={images} />
  <Select.Root
    type="single"
    value={images}
    onValueChange={(v: string) => {
      if (v) images = v;
    }}
  >
    <Select.Trigger
      size="default"
      class="w-16 text-white"
      aria-label="Generations{ariaLabelSuffix}"
    >
      {images}
    </Select.Trigger>
    <Select.Content>
      {#each limits.fee.denominators as opt (opt)}
        <Select.Item value={String(opt)} label={String(opt)} />
      {/each}
    </Select.Content>
  </Select.Root>
  <span class="text-xs text-dark-2">generations</span>

  {#if suggested}
    <p class="w-full text-xs text-dark-2">
      Suggested: {suggested.buzz} ⚡ / {suggested.images === 1
        ? 'generation'
        : `${suggested.images} generations`}
      <button
        type="button"
        class="ml-1 text-blue-4 hover:underline"
        onclick={() => {
          buzz = suggested!.buzz;
          images = String(suggested!.images);
        }}
      >
        Use this
      </button>
    </p>
  {/if}

  <span class="w-full text-xs text-dark-2">Leave empty to clear the fee.</span>
</div>
