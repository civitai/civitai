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
  import { IconTag, IconChevronRight, IconPlus, IconArrowRight } from '@tabler/icons-svelte';
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { deserialize } from '$app/forms';
  import SaleFields from '$lib/components/monetization/SaleFields.svelte';
  import { resolveSaleDraft, type SaleDraftInput } from '$lib/monetization/sales';
  import { isSaleActive, remainingSaleDays, type ModelVersionSaleWindow } from '@civitai/buzz';
  import { budgetMonthOf } from '$lib/monetization/sales';
  import type { PageData } from './$types';

  // Scheduled sales, listed and managed. Starting one lives on the Models tab, where the selection is;
  // this page owns everything after that. Selecting a sale opens a side panel, matching how the models
  // list opens a version.
  type ManageableSale = ModelVersionSaleWindow & { name: string | null; versionCount: number };

  let { data }: { data: PageData } = $props();

  let selectedId = $state<number | null>(null);
  // The panel opens on the sale's detail; the controls that change it are a deliberate second step.
  let editing = $state(false);
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

  const selectedVersions = $derived(
    selectedId == null ? [] : (data.saleVersions[selectedId] ?? [])
  );

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
        if (result.data?.scheduled) {
          const skipped = Number(result.data?.skippedEarlyAccess ?? 0);
          toast.success(
            skipped > 0
              ? `Sale scheduled on ${result.data?.covered} version${result.data?.covered === 1 ? '' : 's'} — ${skipped} skipped, already in early access.`
              : 'Sale scheduled.'
          );
          await closeCreate();
        }
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

  // A selection handed over from Models by "New sale" / "Put on sale". Its presence is what puts this
  // page into creation mode, so the flow is a URL the creator can back out of rather than hidden state.
  const draftVersionIds = $derived(
    (page.url.searchParams.get('versions') ?? '')
      .split(',')
      .map((v) => Number(v.trim()))
      .filter((n) => Number.isInteger(n) && n > 0)
  );
  const creating = $derived(draftVersionIds.length > 0);

  let sale = $state<SaleDraftInput & { name: string }>({
    name: '',
    type: 'Percent',
    amount: undefined,
    startDate: '',
    endDate: '',
  });

  // Seeded when the panel opens, not in the initializer: `daysLeft` is derived, and reading it at
  // construction would capture only its first value. Today, running as long as the budget still allows —
  // the common case is "put this on sale now for as long as I can".
  $effect(() => {
    if (!creating || sale.startDate) return;
    const start = new Date();
    const span = Math.max(1, daysLeft);
    sale.startDate = isoDay(start);
    sale.endDate = isoDay(new Date(start.getTime() + (span - 1) * 86_400_000));
  });

  // What the form can't see about a selection this page never listed: how much of it is early access,
  // and the cheapest price among the rest. undefined = not known, which blocks rather than waves through.
  let earlyAccessCount = $state(0);
  let minCoveredPrice = $state<number | null | undefined>(undefined);
  let loadingPreview = $state(false);
  let previewRequest = 0;
  $effect(() => {
    const ids = draftVersionIds;
    if (ids.length === 0) {
      earlyAccessCount = 0;
      minCoveredPrice = undefined;
      return;
    }
    const seq = ++previewRequest;
    const body = new FormData();
    body.set('versionIds', ids.join(','));
    loadingPreview = true;
    fetch('?/salePreview', { method: 'POST', body })
      .then((r) => r.text())
      .then((r) => {
        if (seq !== previewRequest) return;
        const parsed = deserialize(r);
        if (parsed.type !== 'success') {
          earlyAccessCount = 0;
          minCoveredPrice = undefined;
          return;
        }
        earlyAccessCount = Number(parsed.data?.earlyAccess ?? 0);
        const min = parsed.data?.minCoveredPrice;
        minCoveredPrice = min == null ? null : Number(min);
      })
      .catch(() => {
        if (seq !== previewRequest) return;
        earlyAccessCount = 0;
        minCoveredPrice = undefined;
      })
      .finally(() => {
        if (seq === previewRequest) loadingPreview = false;
      });
  });

  const draft = $derived(
    resolveSaleDraft(
      sale,
      {
        selectedCount: draftVersionIds.length,
        earlyAccessCount,
        minCoveredPrice,
        creatorScore: data.creatorScore,
        tier: data.capTier,
        sales: data.sales,
        overrides: data.saleLimits,
        resolving: loadingPreview,
      },
      now
    )
  );
  const canSchedule = $derived(draft.eligibility.canSchedule && (sale.amount ?? 0) > 0);

  // Creation and management share one panel; leaving creation means dropping the selection from the URL.
  const closeCreate = () => goto('/sales', { replaceState: true });
</script>

<div class="flex flex-col gap-4">
  <div class="flex flex-wrap items-start justify-between gap-3">
    <!-- The shared .page-header rules, so title and subtext match Models. mb-0: the flex row owns
         the spacing here. -->
    <header class="page-header mb-0">
      <h1>Sales</h1>
      <p>
        Temporary discounts across your paid versions. Start one by selecting the versions you want
        to discount.
      </p>
    </header>
    <div class="flex items-center gap-2">
      <span
        class="rounded-full border border-dark-4 px-2.5 py-1 text-xs font-medium tabular-nums text-dark-1"
      >
        {daysLeft} sale-day{daysLeft === 1 ? '' : 's'} left
      </span>
      {#if data.salesEnabled}
        <Button href="/models?for=sale" size="sm">
          <IconPlus class="size-4" />
          New sale
        </Button>
      {/if}
    </div>
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
      <Button href="/models?for=sale" size="sm">Pick versions</Button>
    </div>
  {:else}
    <ul class="flex flex-col gap-2">
      {#each data.manageableSales as sale (sale.id)}
        {@const live = isSaleActive(sale, now)}
        <li>
          <button
            type="button"
            class="flex w-full items-center gap-3 rounded-lg border border-dark-4 p-3 text-left transition-colors hover:border-dark-3"
            onclick={() => {
              selectedId = sale.id;
              editing = false;
            }}
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
  open={creating}
  onOpenChange={(o: boolean) => {
    if (!o) closeCreate();
  }}
>
  <SheetContent side="right" class="w-full gap-0 overflow-y-auto p-0 sm:max-w-md">
    <SheetHeader class="border-b border-dark-4 p-5">
      <SheetTitle class="text-white">New sale</SheetTitle>
      <SheetDescription>
        {draftVersionIds.length} version{draftVersionIds.length === 1 ? '' : 's'} selected
      </SheetDescription>
    </SheetHeader>

    <form
      method="POST"
      action="?/scheduleSale"
      use:enhance={submit}
      class="flex flex-col gap-4 p-5"
    >
      <input type="hidden" name="versionIds" value={draftVersionIds.join(',')} />
      <SaleFields
        bind:sale
        {draft}
        selectedCount={draftVersionIds.length}
        creatorScore={data.creatorScore}
        overrides={data.saleLimits}
      />
      <div class="flex gap-2">
        <Button type="submit" class="flex-1" disabled={!canSchedule}>Schedule sale</Button>
        <Button type="button" variant="ghost" onclick={closeCreate}>Cancel</Button>
      </div>
    </form>
  </SheetContent>
</Sheet>

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
        <!-- What the sale is ON. A creator opening a sale is usually asking which versions it covers,
             so that answer comes before any control that changes it. -->
        <section class="flex flex-col gap-2">
          <span class="text-sm font-medium text-white">
            Versions on sale ({selectedVersions.length})
          </span>
          {#if selectedVersions.length === 0}
            <p class="text-xs text-dark-2">No versions are attached to this sale.</p>
          {:else}
            <ul class="flex max-h-56 flex-col gap-1 overflow-y-auto">
              {#each selectedVersions as v (v.id)}
                <li class="truncate text-xs text-dark-1">
                  {v.modelName} · <span class="text-dark-2">{v.versionName}</span>
                </li>
              {/each}
            </ul>
          {/if}
        </section>

        {#if !editing}
          <Button variant="outline" onclick={() => (editing = true)}>Edit this sale</Button>
        {:else}
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
            <span class="text-sm font-medium text-white">Discount</span>
            <form
              method="POST"
              action="?/deepenSale"
              use:enhance={submit}
              class="flex items-end gap-2"
            >
              <input type="hidden" name="saleId" value={selected.id} />
              <!-- Current → new, because "deepen" alone says nothing about what it is deepened FROM.
                   The field starts one step past the current value, which is also the smallest change
                   the server will accept. -->
              <span class="pb-2 text-sm tabular-nums text-dark-1">{discountLabel(selected)}</span>
              <IconArrowRight class="mb-2.5 size-4 shrink-0 text-dark-2" />
              <div class="flex flex-col gap-1.5">
                <Label for="sale-discount">
                  {selected.discountType === 'Percent' ? 'New percent off' : 'New Buzz off'}
                </Label>
                <Input
                  id="sale-discount"
                  type="number"
                  name="discountAmount"
                  class="w-28"
                  min={selected.discountAmount + 1}
                  max={selected.discountType === 'Percent' ? 99 : undefined}
                  placeholder={String(selected.discountAmount + 1)}
                  required
                />
              </div>
              <Button type="submit" variant="outline">Apply</Button>
            </form>
            <p class="text-xs text-dark-2">
              A running sale can only get cheaper for buyers, so a new discount has to be bigger
              than
              {discountLabel(selected)}. To charge more again, end this sale and schedule another.
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
        {/if}
      </div>
    {/if}
  </SheetContent>
</Sheet>
