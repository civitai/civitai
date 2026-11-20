<script lang="ts">
  import * as ToggleGroup from '@civitai/ui/components/ui/toggle-group/index.js';
  import { currencyMeta } from '$lib/earnings';
  import { BANKABLE_CURRENCIES, FILTERABLE_CURRENCIES } from '$lib/buzz-currency-filter';
  import type { buzzCurrencyState } from '$lib/state/buzz-currency.svelte';

  let {
    currencies,
    selectionLabel,
  }: { currencies: ReturnType<typeof buzzCurrencyState>; selectionLabel: string } = $props();
</script>

<div class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5">
  <p class="text-xs uppercase tracking-wide text-dark-2">Earnings</p>
  <ToggleGroup.Root
    type="multiple"
    variant="outline"
    size="sm"
    spacing={1}
    value={[...currencies.value]}
    onValueChange={(v: string[]) => currencies.set(v)}
    aria-label="Which buzz types the earnings figures count"
    class="flex-wrap"
  >
    {#each FILTERABLE_CURRENCIES as c (c)}
      {@const withdrawable = (BANKABLE_CURRENCIES as readonly string[]).includes(c)}
      <ToggleGroup.Item
        value={c}
        title="{currencyMeta(c).label} — {withdrawable
          ? 'can be withdrawn'
          : 'cannot be withdrawn'}"
        class="gap-1.5 text-xs"
      >
        <span class="size-2 shrink-0 rounded-full" style="background:{currencyMeta(c).color}"
        ></span>
        {currencyMeta(c).label}
      </ToggleGroup.Item>
    {/each}
  </ToggleGroup.Root>
  <span class="rounded bg-dark-5 px-1.5 py-0.5 text-xs text-dark-2">{selectionLabel}</span>
</div>
