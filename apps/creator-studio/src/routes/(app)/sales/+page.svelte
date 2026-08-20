<script lang="ts">
  import { enhance, applyAction } from '$app/forms';
  import { invalidateAll } from '$app/navigation';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import { Label } from '@civitai/ui/components/ui/label/index.js';
  import { toast } from '@civitai/ui/components/ui/sonner/index.js';
  import {
    Sheet,
    SheetContent,
    SheetHeader,
    SheetTitle,
    SheetDescription,
  } from '@civitai/ui/components/ui/sheet/index.js';
  import { IconTag, IconChevronRight } from '@tabler/icons-svelte';
  import { isSaleActive, remainingSaleDays, type ModelVersionSaleWindow } from '@civitai/buzz';
  import { budgetMonthOf } from '$lib/monetization/sales';
  import type { PageData } from './$types';

  // Scheduled sales, listed and managed. Starting one lives on the Models tab, where the selection is;
  // this page owns everything after that. Selecting a sale opens a side panel, matching how the models
  // list opens a version.
  type ManageableSale = ModelVersionSaleWindow & { name: string | null; versionCount: number };

  let { data }: { data: PageData } = $props();

  let selectedId = $state<number | null>(null);
  // Re-resolved from data rather than held as its own copy, so an action's invalidateAll refreshes the
  // open panel instead of leaving it showing the sale as it was before the edit.
  const selected = $derived(
    selectedId == null ? null : (data.manageableSales.find((s) => s.id === selectedId) ?? null)
  );

  // A tick, so "Running" and the day budget do not freeze at first render on a page that stays open —
  // a sale starting five minutes from now should not need a reload to look started.
  let now = $state(new Date());
  $effect(() => {
    const t = setInterval(() => (now = new Date()), 30_000);
    return () => clearInterval(t);
  });

  const daysLeft = $derived(
    remainingSaleDays(data.capTier, data.sales, budgetMonthOf(now), data.saleLimits)
  );

  // A custom enhance callback REPLACES the default, so applyAction has to run or a refused edit looks
  // exactly like a successful one.
  const submit = () => {
    return async ({ result }: { result: any }) => {
      if (result.type === 'failure') toast.error(String(result.data?.error ?? 'That did not work'));
      else if (result.type === 'success') {
        await invalidateAll();
        if (result.data?.cancelled) selectedId = null;
      }
      await applyAction(result);
    };
  };

  const fmt = (d: Date) =>
    d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
  const discountLabel = (s: ManageableSale) =>
    s.discountType === 'Percent' ? `${s.discountAmount}% off` : `${s.discountAmount} Buzz off`;
  // The last day the creator picked, not the exclusive boundary stored — showing the boundary reads as a
  // sale running a day longer than they set.
  const lastDay = (s: ManageableSale) => new Date(s.endsAt.getTime() - 86_400_000);
  const isoDay = (d: Date) => d.toISOString().slice(0, 10);
</script>

<div class="flex flex-col gap-4">
  <div class="flex flex-wrap items-baseline justify-between gap-3">
    <div class="flex flex-col gap-1">
      <h1 class="text-2xl font-bold text-white">Sales</h1>
      <p class="text-sm text-dark-2">
        Temporary discounts across your paid versions. Start one from Models by selecting the
        versions you want to discount.
      </p>
    </div>
    <span class="text-sm text-dark-2">{daysLeft} sale-days left this month</span>
  </div>

  {#if !data.salesEnabled}
    <p class="rounded-lg border border-dark-4 p-4 text-sm text-dark-2">
      Scheduled sales aren't available on your account yet.
    </p>
  {:else if data.manageableSales.length === 0}
    <div class="flex flex-col items-start gap-2 rounded-lg border border-dark-4 p-6">
      <span class="text-sm font-medium text-white">No sales running or scheduled</span>
      <p class="text-sm text-dark-2">
        Pick the versions you want to discount on Models, then choose “Schedule a sale”.
      </p>
      <Button href="/models" variant="outline" size="sm">Go to Models</Button>
    </div>
  {:else}
    <ul class="flex flex-col gap-2">
      {#each data.manageableSales as sale (sale.id)}
        {@const live = isSaleActive(sale, now)}
        <li>
          <button
            type="button"
            class="flex w-full items-center gap-3 rounded-lg border border-dark-4 p-3 text-left transition-colors hover:border-dark-3"
            onclick={() => (selectedId = sale.id)}
          >
            <span
              class="rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide {live
                ? 'bg-green-4/20 text-green-3'
                : 'bg-blue-4/20 text-blue-3'}"
            >
              {live ? 'Running' : 'Scheduled'}
            </span>
            <span class="min-w-0 flex-1">
              <span class="block truncate text-sm font-semibold text-white">
                {sale.name || discountLabel(sale)}
              </span>
              <span class="block text-xs text-dark-2">
                {discountLabel(sale)} · {fmt(sale.startsAt)} – {fmt(lastDay(sale))} ·
                {sale.versionCount} version{sale.versionCount === 1 ? '' : 's'}
              </span>
            </span>
            <IconChevronRight class="size-4 shrink-0 text-dark-2" />
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<Sheet
  open={selected != null}
  onOpenChange={(o: boolean) => {
    if (!o) selectedId = null;
  }}
>
  <SheetContent side="right" class="w-full gap-0 overflow-y-auto p-0 sm:max-w-md">
    {#if selected}
      {@const live = isSaleActive(selected, now)}
      <SheetHeader class="border-b border-dark-4 p-5">
        <SheetTitle class="flex items-center gap-2 text-white">
          <IconTag class="size-4" />
          {selected.name || discountLabel(selected)}
        </SheetTitle>
        <SheetDescription>
          {discountLabel(selected)} · {fmt(selected.startsAt)} – {fmt(lastDay(selected))} ·
          {selected.versionCount} version{selected.versionCount === 1 ? '' : 's'}
        </SheetDescription>
      </SheetHeader>

      <div class="flex flex-col gap-6 p-5">
        <!-- Only the directions the rules allow. Extending, softening and adding versions are refused by
             the server, so they are not offered here rather than offered and rejected. -->
        <section class="flex flex-col gap-2">
          <span class="text-sm font-medium text-white">End earlier</span>
          <form
            method="POST"
            action="?/shortenSale"
            use:enhance={submit}
            class="flex items-end gap-2"
          >
            <input type="hidden" name="saleId" value={selected.id} />
            <div class="flex flex-col gap-1.5">
              <Label for="sale-last-day">New last day</Label>
              <Input
                id="sale-last-day"
                type="date"
                name="lastDay"
                class="w-40"
                min={isoDay(new Date(Math.max(selected.startsAt.getTime(), now.getTime())))}
                max={isoDay(lastDay(selected))}
                required
              />
            </div>
            <Button type="submit" variant="outline">Shorten</Button>
          </form>
          <p class="text-xs text-dark-2">
            {live
              ? 'The days you cut are returned to your monthly budget.'
              : 'A shorter window costs fewer sale-days.'}
          </p>
        </section>

        <section class="flex flex-col gap-2">
          <span class="text-sm font-medium text-white">Deepen the discount</span>
          <form
            method="POST"
            action="?/deepenSale"
            use:enhance={submit}
            class="flex items-end gap-2"
          >
            <input type="hidden" name="saleId" value={selected.id} />
            <div class="flex flex-col gap-1.5">
              <Label for="sale-discount">
                {selected.discountType === 'Percent' ? 'Percent off' : 'Buzz off'}
              </Label>
              <Input
                id="sale-discount"
                type="number"
                name="discountAmount"
                class="w-28"
                min={selected.discountAmount + 1}
                max={selected.discountType === 'Percent' ? 99 : undefined}
                required
              />
            </div>
            <Button type="submit" variant="outline">Deepen</Button>
          </form>
          <p class="text-xs text-dark-2">
            A running sale's discount can only go deeper — buyers never pay more than it advertised.
          </p>
        </section>

        <section class="flex flex-col gap-2 border-t border-dark-4 pt-5">
          <form method="POST" action="?/cancelSale" use:enhance={submit}>
            <input type="hidden" name="saleId" value={selected.id} />
            <Button type="submit" variant="destructive" class="w-full">
              {live ? 'End this sale now' : 'Cancel this sale'}
            </Button>
          </form>
          <p class="text-xs text-dark-2">
            {live
              ? 'Buyers keep what they already bought. The unused days return to your budget.'
              : 'It never runs, and all of its days return to your budget.'}
          </p>
        </section>
      </div>
    {/if}
  </SheetContent>
</Sheet>
