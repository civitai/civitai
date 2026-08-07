<script lang="ts">
  import {
    CREATOR_USAGE_CONTROLS,
    GENERATION_ONLY_HINT,
    type CreatorUsageControl,
  } from '$lib/monetization/paid-access';

  let {
    value = $bindable(),
    name = 'usageControl',
    disabled = false,
    allowGenerationOnly = true,
  }: {
    value: CreatorUsageControl;
    name?: string;
    disabled?: boolean;
    /** Gold-gated server-side; false greys out the gen-only option but still allows a move back to Download. */
    allowGenerationOnly?: boolean;
  } = $props();
</script>

<input type="hidden" {name} {value} />
<div class="grid grid-cols-2 gap-2">
  {#each CREATOR_USAGE_CONTROLS as opt (opt.value)}
    {@const optDisabled = disabled || (!allowGenerationOnly && opt.value !== 'Download')}
    <button
      type="button"
      disabled={optDisabled}
      title={optDisabled && !disabled ? GENERATION_ONLY_HINT : undefined}
      onclick={() => (value = opt.value)}
      class="flex flex-col gap-1 rounded-lg border p-3 text-left transition-colors {value ===
      opt.value
        ? 'border-blue-4 bg-blue-4/10'
        : 'border-dark-4 hover:border-dark-3'} {optDisabled ? 'cursor-not-allowed opacity-50' : ''}"
    >
      <span class="text-sm font-semibold text-white">{opt.label}</span>
      <span class="text-xs text-dark-2">{opt.hint}</span>
    </button>
  {/each}
</div>
