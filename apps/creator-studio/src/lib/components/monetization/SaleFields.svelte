<script lang="ts">
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import { Label } from '@civitai/ui/components/ui/label/index.js';
  import * as Alert from '@civitai/ui/components/ui/alert/index.js';
  import { IconAlertTriangle } from '@tabler/icons-svelte';
  import NumberInput from '$lib/components/NumberInput.svelte';
  import {
    maxSaleLeadDays,
    minCreatorScoreForSale,
    type ResolvedSaleDraft,
    type SaleDraftInput,
  } from '$lib/monetization/sales';
  import type { SaleLimitOverrides } from '@civitai/buzz';

  // Scheduling a sale over a selection of versions. A sale is an overlay on the base price — it never
  // writes the price — so nothing here edits a version's own terms. The draft is resolved by the parent
  // (resolveSaleDraft) so the dialog can gate submit on the same answer this renders.
  let {
    sale = $bindable(),
    draft,
    selectedCount,
    creatorScore,
    overrides,
  }: {
    sale: SaleDraftInput & { name: string };
    draft: ResolvedSaleDraft;
    selectedCount: number;
    creatorScore: number;
    /** Operator-moved limits from the `sale-limits` KeyValue row; defaults apply when absent. */
    overrides: SaleLimitOverrides;
  } = $props();

  const minScore = $derived(minCreatorScoreForSale(overrides));

  const monthLabel = $derived(
    draft.startsAt
      ? draft.startsAt.toLocaleDateString(undefined, {
          month: 'long',
          year: 'numeric',
          timeZone: 'UTC',
        })
      : ''
  );

  const belowScoreFloor = $derived(creatorScore < minScore);
  const scoreProgress = $derived(Math.min(100, Math.round((creatorScore / minScore) * 100)));

  const todayUtc = new Date().toISOString().slice(0, 10);
  const latestStart = $derived(
    new Date(Date.now() + maxSaleLeadDays(overrides) * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10)
  );

  // The picker stops at the budget rather than letting a creator choose a window the save will refuse.
  // The refusal stays — this bound is the same arithmetic offered earlier, not a replacement for it, and
  // it can only be as right as the days-left figure, which moves with the month the sale starts in.
  const latestLastDay = $derived.by(() => {
    const start = sale.startDate ? new Date(`${sale.startDate}T00:00:00.000Z`) : null;
    if (!start || Number.isNaN(start.getTime()) || draft.eligibility.daysLeft <= 0)
      return undefined;
    return new Date(start.getTime() + (draft.eligibility.daysLeft - 1) * 86_400_000)
      .toISOString()
      .slice(0, 10);
  });
</script>

<!-- Resolved instants, not the raw day strings: the server must never have to guess a timezone. -->
<input type="hidden" name="startsAt" value={draft.startsAt?.toISOString() ?? ''} />
<input type="hidden" name="endsAt" value={draft.endsAt?.toISOString() ?? ''} />
<input type="hidden" name="discountType" value={sale.type} />

{#if belowScoreFloor}
  <!-- Progress, not a flat refusal: a paying member below the floor is otherwise told a feature their
       membership advertises just doesn't work, with nothing to say what would change that. -->
  <div class="flex flex-col gap-1.5 rounded-lg border border-dark-4 p-3">
    <span class="text-sm font-semibold text-white">Sales unlock as your creator score grows</span>
    <div class="h-1.5 w-full overflow-hidden rounded-full bg-dark-4">
      <div class="h-full rounded-full bg-blue-4" style="width: {scoreProgress}%"></div>
    </div>
    <span class="text-xs text-dark-2">
      Creator score {creatorScore.toLocaleString()} of {minScore.toLocaleString()}
    </span>
  </div>
{:else}
  <div class="flex flex-col gap-4">
    <div class="flex flex-col gap-1.5">
      <Label for="sale-name">Name <span class="text-dark-2">(optional)</span></Label>
      <Input
        id="sale-name"
        name="name"
        maxlength={60}
        placeholder="Summer sale"
        autocomplete="off"
        bind:value={sale.name}
      />
    </div>

    <div class="flex flex-col gap-1.5">
      <Label>Discount</Label>
      <div class="grid grid-cols-2 gap-2">
        <button
          type="button"
          onclick={() => (sale.type = 'Percent')}
          class="rounded-lg border p-2.5 text-left text-sm transition-colors {sale.type ===
          'Percent'
            ? 'border-blue-4 bg-blue-4/10 text-white'
            : 'border-dark-4 text-dark-1 hover:border-dark-3'}"
        >
          Percentage off
        </button>
        <button
          type="button"
          onclick={() => (sale.type = 'Fixed')}
          class="rounded-lg border p-2.5 text-left text-sm transition-colors {sale.type === 'Fixed'
            ? 'border-blue-4 bg-blue-4/10 text-white'
            : 'border-dark-4 text-dark-1 hover:border-dark-3'}"
        >
          Buzz off
        </button>
      </div>
      <NumberInput
        name="discountAmount"
        bind:value={sale.amount}
        min={1}
        max={sale.type === 'Percent' ? 99 : undefined}
        placeholder={sale.type === 'Percent' ? '20' : '100'}
      />
      <p class="text-xs text-dark-2">
        {#if sale.type === 'Percent'}
          Comes off the download price and any separate generation price alike.
        {:else}
          Comes off both prices, and a version priced under it simply becomes free — one amount
          lands differently across versions at different prices.
        {/if}
      </p>
    </div>

    <div class="grid grid-cols-2 gap-2">
      <div class="flex flex-col gap-1.5">
        <Label for="sale-start">Starts</Label>
        <Input
          id="sale-start"
          type="date"
          min={todayUtc}
          max={latestStart}
          bind:value={sale.startDate}
        />
      </div>
      <div class="flex flex-col gap-1.5">
        <Label for="sale-end">Last day</Label>
        <Input
          id="sale-end"
          type="date"
          min={sale.startDate || todayUtc}
          max={latestLastDay}
          bind:value={sale.endDate}
        />
      </div>
    </div>

    {#if draft.draftDays > 0 && draft.budgetMonth}
      <!-- Names the month rather than saying "this month": a sale counts against the month it STARTS
           in, so a window crossing a boundary is charged to the earlier one. -->
      <p class="text-xs text-dark-2">
        {draft.draftDays} sale-day{draft.draftDays === 1 ? '' : 's'} against {monthLabel} — you have
        {draft.eligibility.daysLeft} of {draft.eligibility.daysAllowed} left that month.
      </p>
    {/if}

    {#if draft.eligibility.blockedReason}
      <Alert.Root variant="destructive">
        <IconAlertTriangle />
        <Alert.Title>This sale can't be scheduled</Alert.Title>
        <Alert.Description>{draft.eligibility.blockedReason}</Alert.Description>
      </Alert.Root>
    {:else if draft.eligibility.partialNotice}
      {@const n = draft.eligibility.partialNotice}
      <Alert.Root>
        <IconAlertTriangle />
        <Alert.Title>Applies to {n.applies} of {selectedCount} selected</Alert.Title>
        <Alert.Description>
          {#if n.earlyAccess > 0}
            {n.earlyAccess}
            {n.earlyAccess === 1 ? 'is' : 'are'} in early access, which already prices itself out when
            the window closes — a sale can't run on top of one.
          {/if}
          {#if n.unpriced > 0}
            {n.unpriced}
            {n.unpriced === 1 ? 'has' : 'have'} no permanent access price, so there is nothing for a sale
            to take Buzz off.
          {/if}
        </Alert.Description>
      </Alert.Root>
    {/if}
  </div>
{/if}
