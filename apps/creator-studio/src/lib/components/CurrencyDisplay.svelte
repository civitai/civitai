<script lang="ts">
  import { buzzNumber, currencyMeta, formatAmount } from '$lib/earnings';

  // Cash → $ string; buzz/bank (and the currency-less generic case) → ⚡ + number. The ⚡ is sized in `em` so it
  // scales with the surrounding font-size.
  let { amount, currency }: { amount: number; currency?: string } = $props();
  const isCash = $derived(currency != null && currencyMeta(currency).family === 'cash');
  const cash = $derived(currency != null ? formatAmount(amount, currency) : '');
</script>

{#if isCash}{cash}{:else}<span class="whitespace-nowrap"><span class="mr-0.5 text-[0.82em]">⚡</span>{buzzNumber(amount)}</span>{/if}
