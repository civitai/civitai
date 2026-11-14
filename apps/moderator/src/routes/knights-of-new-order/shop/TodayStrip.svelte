<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { invalidateAll } from '$app/navigation';
  import { num } from '$lib/format';
  import ItemThumb from './ItemThumb.svelte';
  import { DEAL_LABEL, countdown, type Kind, type TodayEntry } from './shop-view';
  import type { ShopItemRow } from '$lib/server/knights/shop-catalog.service';

  let {
    items,
    entries,
    day,
    now,
  }: { items: readonly ShopItemRow[]; entries: readonly TodayEntry[]; day: string; now: string } =
    $props();

  // Counts to the server's UTC midnight, so a skewed device clock does not move the reload.
  const skew = untrack(() => Date.parse(now) - Date.now());
  let nowMs = $state(untrack(() => Date.parse(now)));
  let reloadedFor = '';
  const endsAt = $derived(Date.parse(`${day}T00:00:00Z`) + 86_400_000);
  const remaining = $derived(endsAt - nowMs);

  onMount(() => {
    const timer = setInterval(() => {
      nowMs = Date.now() + skew;
      if (reloadedFor !== day && nowMs >= endsAt) {
        reloadedFor = day;
        void invalidateAll();
      }
    }, 1000);
    return () => clearInterval(timer);
  });

  const byId = $derived(new Map(items.map((item) => [item.id, item])));
  const stock = $derived(
    entries.flatMap((entry) => {
      const item = byId.get(entry.id);
      return item ? [{ item, ...entry }] : [];
    })
  );
  const hiddenCount = $derived(stock.filter((entry) => entry.hidden).length);
  const visible = $derived(stock.filter((entry) => !entry.hidden));
  const deals = $derived(visible.filter((entry) => entry.deal));
  const rotating = $derived(visible.filter((entry) => entry.item.rotating));
  const fixed = $derived(visible.filter((entry) => !entry.item.rotating));
</script>

<section class="mb-5 rounded-xl border border-dark-4 bg-dark-6 p-4">
  <div class="mb-3 flex flex-wrap items-baseline justify-between gap-2">
    <h2 class="text-sm font-semibold text-white">
      Today in the shop
      <span class="font-normal text-dark-2">· new stock in {countdown(remaining)}</span>
    </h2>
    <a class="text-sm text-blue-4 hover:underline" href="?tab=preview">Preview another day →</a>
  </div>
  {#if !visible.length}
    <p class="text-sm text-dark-2">Nothing is on sale today.</p>
  {:else}
    <div class="flex flex-wrap gap-x-8 gap-y-4">
      <div>
        <p class="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-dark-2">Deals</p>
        <div class="flex flex-wrap gap-2">
          {#each deals as { item, price } (item.id)}
            <div
              class="flex items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 py-1.5 pr-3 pl-1.5"
            >
              <ItemThumb
                kind={item.kind as Kind}
                name={item.name}
                tier={item.tier}
                cosmeticType={item.cosmeticType}
                cosmeticData={item.cosmeticData}
                size="sm"
              />
              <div class="text-sm leading-tight">
                <p class="max-w-40 truncate text-white">{item.name}</p>
                <p class="tabular-nums text-amber-300">
                  {num(price)} <s class="text-xs text-dark-2">{num(item.price)}</s>
                  <span class="text-xs">({DEAL_LABEL})</span>
                </p>
              </div>
            </div>
          {:else}
            <span class="text-sm text-dark-2">None today</span>
          {/each}
        </div>
      </div>
      <div>
        <p class="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-dark-2">Rotating</p>
        <div class="flex flex-wrap gap-2">
          {#each rotating as { item } (item.id)}
            <div class="flex w-16 flex-col items-center gap-1" title={item.name}>
              <ItemThumb
                kind={item.kind as Kind}
                name={item.name}
                tier={item.tier}
                cosmeticType={item.cosmeticType}
                cosmeticData={item.cosmeticData}
              />
              <span class="w-full truncate text-center text-[11px] text-dark-2">{item.name}</span>
            </div>
          {:else}
            <span class="text-sm text-dark-2">No rotating items</span>
          {/each}
        </div>
      </div>
      <div>
        <p class="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-dark-2">
          Always on sale
        </p>
        <p class="text-sm text-dark-0">{fixed.length} {fixed.length === 1 ? 'item' : 'items'}</p>
      </div>
    </div>
    {#if hiddenCount}
      <p class="mt-3 text-xs text-dark-2">
        {hiddenCount} drawn for today but hidden from players (cosmetic missing); not shown above.
      </p>
    {/if}
  {/if}
</section>
