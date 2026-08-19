<script lang="ts">
  import { enhance, applyAction } from '$app/forms';
  import { invalidateAll } from '$app/navigation';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import { toast } from '@civitai/ui/components/ui/sonner/index.js';
  import { IconTag } from '@tabler/icons-svelte';
  import {
    isSaleActive,
    remainingSaleDays,
    type ModelVersionSaleWindow,
    type SaleLimitOverrides,
  } from '@civitai/buzz';
  import { budgetMonthOf } from '$lib/monetization/sales';

  // Running and scheduled sales, and the only edits the rules allow: end it earlier, or discount deeper.
  // Extending and softening are refused server-side in the UPDATE's own WHERE clause, so this surface
  // simply doesn't offer them rather than offering something that would be rejected.
  type ManageableSale = ModelVersionSaleWindow & { name: string | null; versionCount: number };

  let {
    sales,
    allSales,
    capTier,
    overrides,
  }: {
    sales: ManageableSale[];
    /** Every recent sale, including finished ones — the budget counts those too. */
    allSales: ModelVersionSaleWindow[];
    capTier: string | null;
    overrides: SaleLimitOverrides;
  } = $props();

  const now = new Date();
  const daysLeftThisMonth = $derived(
    remainingSaleDays(capTier, allSales, budgetMonthOf(now), overrides)
  );
  const todayUtc = new Date().toISOString().slice(0, 10);

  // A custom enhance callback REPLACES the default, so applyAction has to run or a refused edit looks
  // exactly like a successful one.
  const submit = () => {
    return async ({ result }: { result: any }) => {
      if (result.type === 'failure') toast.error(String(result.data?.error ?? 'That did not work'));
      else if (result.type === 'success') await invalidateAll();
      await applyAction(result);
    };
  };

  const fmt = (d: Date) =>
    d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
  const discountLabel = (s: ManageableSale) =>
    s.discountType === 'Percent' ? `${s.discountAmount}% off` : `${s.discountAmount} Buzz off`;
  // The last day a creator picked, not the exclusive boundary stored — showing the boundary reads as a
  // sale running a day longer than they set.
  const lastDay = (s: ManageableSale) => new Date(s.endsAt.getTime() - 24 * 60 * 60 * 1000);
</script>

<section class="flex flex-col gap-2">
  <div class="flex items-baseline justify-between gap-3">
    <h2 class="flex items-center gap-1.5 text-sm font-semibold text-white">
      <IconTag class="size-4" />
      Sales
    </h2>
    <span class="text-xs text-dark-2">{daysLeftThisMonth} sale-days left this month</span>
  </div>

  {#if sales.length === 0}
    <p class="text-xs text-dark-2">
      No sales running or scheduled. Select versions and choose “Schedule a sale”.
    </p>
  {:else}
    <ul class="flex flex-col gap-2">
      {#each sales as sale (sale.id)}
        {@const live = isSaleActive(sale, now)}
        <li class="flex flex-col gap-2 rounded-lg border border-dark-4 p-3">
          <div class="flex flex-wrap items-center gap-2">
            <span
              class="rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide {live
                ? 'bg-green-4/20 text-green-3'
                : 'bg-blue-4/20 text-blue-3'}"
            >
              {live ? 'Running' : 'Scheduled'}
            </span>
            <span class="text-sm font-semibold text-white">{sale.name || discountLabel(sale)}</span>
            {#if sale.name}<span class="text-xs text-dark-1">{discountLabel(sale)}</span>{/if}
            <span class="text-xs text-dark-2">
              {fmt(sale.startsAt)} – {fmt(lastDay(sale))} · {sale.versionCount} version{sale.versionCount ===
              1
                ? ''
                : 's'}
            </span>
          </div>

          <div class="flex flex-wrap items-end gap-2">
            <form
              method="POST"
              action="?/shortenSale"
              use:enhance={submit}
              class="flex items-end gap-1.5"
            >
              <input type="hidden" name="saleId" value={sale.id} />
              <label class="flex flex-col gap-1 text-[10px] uppercase tracking-wider text-dark-2">
                End earlier
                <!-- The sale's new LAST day, matching how it was scheduled. Bounded below as well as
                     above: moving the end to or before the start would refund days the sale served. -->
                <Input
                  type="date"
                  name="lastDay"
                  class="h-8 w-36"
                  min={new Date(Math.max(sale.startsAt.getTime(), Date.now()))
                    .toISOString()
                    .slice(0, 10)}
                  max={lastDay(sale).toISOString().slice(0, 10)}
                  required
                />
              </label>
              <Button type="submit" variant="outline" size="sm">Shorten</Button>
            </form>

            <form
              method="POST"
              action="?/deepenSale"
              use:enhance={submit}
              class="flex items-end gap-1.5"
            >
              <input type="hidden" name="saleId" value={sale.id} />
              <label class="flex flex-col gap-1 text-[10px] uppercase tracking-wider text-dark-2">
                Deeper discount
                <Input
                  type="number"
                  name="discountAmount"
                  class="h-8 w-24"
                  min={sale.discountAmount + 1}
                  max={sale.discountType === 'Percent' ? 99 : undefined}
                  required
                />
              </label>
              <Button type="submit" variant="outline" size="sm">Deepen</Button>
            </form>

            <form method="POST" action="?/cancelSale" use:enhance={submit} class="ml-auto">
              <input type="hidden" name="saleId" value={sale.id} />
              <Button type="submit" variant="ghost" size="sm" class="text-red-4">
                {live ? 'End now' : 'Cancel'}
              </Button>
            </form>
          </div>

          <p class="text-xs text-dark-2">
            {#if live}
              Ending it early returns the unused days to your monthly budget.
            {:else}
              Cancelling before it starts returns all {Math.ceil(
                (sale.endsAt.getTime() - sale.startsAt.getTime()) / 86_400_000
              )} days.
            {/if}
          </p>
        </li>
      {/each}
    </ul>
  {/if}
</section>
