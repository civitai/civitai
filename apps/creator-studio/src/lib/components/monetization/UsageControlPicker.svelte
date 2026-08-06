<script lang="ts">
  import { CREATOR_USAGE_CONTROLS, type CreatorUsageControl } from '$lib/monetization/paid-access';

  let {
    value = $bindable(),
    name = 'usageControl',
    disabled = false,
  }: {
    value: CreatorUsageControl;
    name?: string;
    disabled?: boolean;
  } = $props();
</script>

<input type="hidden" {name} {value} />
<div class="grid grid-cols-2 gap-2">
  {#each CREATOR_USAGE_CONTROLS as opt (opt.value)}
    <button
      type="button"
      {disabled}
      onclick={() => (value = opt.value)}
      class="flex flex-col gap-1 rounded-lg border p-3 text-left transition-colors {value ===
      opt.value
        ? 'border-blue-4 bg-blue-4/10'
        : 'border-dark-4 hover:border-dark-3'} {disabled ? 'cursor-not-allowed opacity-50' : ''}"
    >
      <span class="text-sm font-semibold text-white">{opt.label}</span>
      <span class="text-xs text-dark-2">{opt.hint}</span>
    </button>
  {/each}
</div>
