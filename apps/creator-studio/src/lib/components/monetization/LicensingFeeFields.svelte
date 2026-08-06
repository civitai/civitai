<script lang="ts">
  import * as Select from '@civitai/ui/components/ui/select/index.js';
  import NumberInput from '$lib/components/NumberInput.svelte';
  import CapUpsell from '$lib/components/CapUpsell.svelte';
  import { feeMaxFor } from '$lib/monetization/fee';
  import type { MonetizationLimits, CapTier } from '@civitai/buzz';

  // The buzz-per-N-generations pair, shared by the per-version sidebar and the bulk dialog.
  //
  // `capFor` is supplied by the caller rather than derived here: the ceiling depends on model type and
  // base model, which the sidebar reads off one version and the bulk dialog has to resolve across a
  // whole selection. `suggested` is likewise optional — bulk only knows it when a type filter pins one.
  let {
    buzz = $bindable(),
    images = $bindable(),
    limits,
    capTier,
    capFor,
    suggested,
    ariaLabelSuffix = '',
  }: {
    buzz: number | undefined;
    images: string;
    limits: MonetizationLimits;
    capTier: CapTier;
    capFor: (tier: CapTier, images: number) => number;
    suggested?: { buzz: number; images: number };
    ariaLabelSuffix?: string;
  } = $props();

  // The creator's own ceiling, used for the upsell and the over-cap warning.
  const tierMax = $derived(feeMaxFor(limits, Number(images)));
  // What the input actually allows. Clamping to the TIER cap would rewrite a grandfathered fee the
  // moment the drawer opens — the server only blocks raises, and never rewrites the stored value, so a
  // lapse must not cost a creator their setting. Gold is the absolute ceiling, and capFor is already
  // media- and type-aware.
  const ceiling = $derived(capFor('gold', Number(images)));
  const overCap = $derived((buzz ?? 0) > tierMax);
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

  <div class="w-full">
    <CapUpsell
      value={buzz}
      cap={tierMax}
      {capTier}
      capFor={(t: CapTier) => capFor(t, Number(images))}
      title="Licensing fee"
      perLabel="{images} generation{images === '1' ? '' : 's'}"
      expanded={overCap}
    />
  </div>

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

  {#if overCap}
    <span class="w-full text-xs text-yellow-5">
      Above your tier's cap of {tierMax} ⚡ per {images} generation{images === '1' ? '' : 's'} — you'll
      earn the capped rate until you upgrade. The value you set is kept.
    </span>
  {/if}

  <span class="w-full text-xs text-dark-2">Leave empty to clear the fee.</span>
</div>
