<script lang="ts">
  import { PRICING_SLOT_EXPLAINER } from '@civitai/buzz';
  import { formatFeeRatio } from '$lib/monetization/fee';
  import { modelUrl } from '$lib/model-url';
  import type { PricingSlotEntry } from '$lib/server/monetization/pricing-slot';

  let { slots }: { slots: PricingSlotEntry[] } = $props();

  const thisMonth = $derived(slots.filter((s) => s.countsThisMonth));
  const earlier = $derived(slots.filter((s) => !s.countsThisMonth));

  // Pinned locale, like date-range.ts and impressions.ts: this renders on the server too, and a
  // locale-dependent string is a hydration mismatch.
  const dateFormat = new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });

  // A deleted model keeps its slot but has no page, and a name we no longer hold means the row outlived
  // its entity — say which without claiming a cause we cannot check.
  function slotLabel(slot: PricingSlotEntry): string {
    if (!slot.modelName) return `#${slot.entityId} — no longer available`;
    return slot.versionName ? `${slot.modelName} · ${slot.versionName}` : slot.modelName;
  }

  // The ledger stores no amount, so these are the version's CURRENT prices, not the ones it was
  // priced at.
  function priceLabel(slot: PricingSlotEntry): string {
    const parts: string[] = [];
    // formatFeeRatio, not the raw per-image number: the default fee is 0.1/image, which every other
    // surface shows as "1 ⚡ / 10 images".
    if (slot.licensingFee) parts.push(`${formatFeeRatio(slot.licensingFee)} license fee`);
    if (slot.accessPrice) parts.push(`${slot.accessPrice.toLocaleString()} ⚡ access`);
    if (slot.generationPrice) parts.push(`${slot.generationPrice.toLocaleString()} ⚡ generation`);
    // Not 'released on your next save': the row is still here, and a release can refuse for reasons we
    // can't distinguish — releasePricingSlot fails closed when it can't tell.
    return parts.length ? parts.join(' · ') : 'No current price — this slot has not been returned';
  }
</script>

{#snippet rows(entries: PricingSlotEntry[])}
  <ul class="flex flex-col gap-1.5">
    {#each entries as slot (slot.entityId)}
      <li class="flex flex-wrap items-baseline gap-x-2">
        <span class="w-24 shrink-0 text-dark-2">{dateFormat.format(slot.createdAt)}</span>
        {#if slot.modelId}
          <a
            class="text-blue-3 hover:underline"
            href={modelUrl(slot.modelId, { nsfw: slot.modelNsfw, nsfwLevel: slot.modelNsfwLevel })}
            target="_blank"
            rel="noreferrer"
          >
            {slotLabel(slot)}
          </a>
        {:else}
          <span class="text-dark-2">{slotLabel(slot)}</span>
        {/if}
        <span class="text-dark-2">{priceLabel(slot)}</span>
      </li>
    {/each}
  </ul>
{/snippet}

<div class="flex flex-col gap-3 text-xs">
  <p class="text-dark-2">{PRICING_SLOT_EXPLAINER}</p>
  {#if slots.length === 0}
    <p class="text-dark-2">You haven't priced any model versions yet.</p>
  {:else}
    <div class="flex flex-col gap-1.5">
      <span class="font-semibold text-white">
        This month · {thisMonth.length}
        {thisMonth.length === 1 ? 'slot' : 'slots'}
      </span>
      {#if thisMonth.length === 0}
        <span class="text-dark-2">Nothing yet.</span>
      {:else}
        {@render rows(thisMonth)}
      {/if}
    </div>
    {#if earlier.length > 0}
      <div class="flex flex-col gap-1.5">
        <span class="font-semibold text-white">Priced earlier — not counted this month</span>
        {@render rows(earlier)}
      </div>
    {/if}
    <p class="text-dark-2">
      Amounts are what each version charges now. A price changed after it was set shows its current
      value.
    </p>
  {/if}
</div>
