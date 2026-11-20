<script lang="ts">
  import BuzzCurrencyToggleGroup from './BuzzCurrencyToggleGroup.svelte';
  import type { buzzCurrencyState } from '$lib/state/buzz-currency.svelte';

  let {
    currencies,
    selectionLabel,
  }: { currencies: ReturnType<typeof buzzCurrencyState>; selectionLabel: string } = $props();
</script>

<div class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5">
  <p class="text-xs uppercase tracking-wide text-dark-2">Earnings</p>
  <BuzzCurrencyToggleGroup {currencies} ariaLabel="Which buzz types the earnings figures count" />
  <span class="rounded bg-dark-5 px-1.5 py-0.5 text-xs text-dark-2">{selectionLabel}</span>
</div>
