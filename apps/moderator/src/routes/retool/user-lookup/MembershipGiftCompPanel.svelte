<script lang="ts">
  import { enhance } from '$app/forms';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import { Label } from '@civitai/ui/components/ui/label/index.js';
  import { FormState } from '$lib/form-state.svelte';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';
  import { dateTime } from '$lib/format';
  import {
    COMP_GIFT_DAILY_LIMIT,
    COMP_GIFT_MAX_MONTHS,
    COMP_GIFT_REASON_MIN,
    COMP_GIFT_TIERS,
    type CompGiftPreview,
    type CompGiftResult,
  } from '$lib/membership-gift-comp';

  let { userId }: { userId: number } = $props();

  let tier = $state<string>('gold');
  let months = $state('3');
  let reason = $state('');
  let message = $state('');
  let anonymous = $state(false);
  let preview = $state<CompGiftPreview | null>(null);
  let confirming = $state(false);
  let comped = $state<CompGiftResult | null>(null);

  // A preview answers for the tier and months it was asked about; changing them makes it stale.
  const previewCurrent = $derived(
    preview !== null && preview.tier === tier && String(preview.months) === String(months)
  );
  const canComp = $derived(previewCurrent && reason.trim().length >= COMP_GIFT_REASON_MIN);

  const giftabilityText = (p: CompGiftPreview) => {
    const g = p.giftability;
    if (g.status === 'no-subscription')
      return 'No membership: accepting starts a free subscription at the gift tier.';
    if (g.status === 'active')
      return `Member (${g.tier}), renews ${dateTime(g.renewsAt)}${g.cancelsAtPeriodEnd ? ', set to cancel' : ''}. Accepting decides how the months apply.`;
    return `Membership state: ${g.reason}. Accepting applies the gift as a discount on renewals.`;
  };

  const previewForm = new FormState({
    reset: false,
    onSubmit: () => {
      preview = null;
      comped = null;
      confirming = false;
      compForm.error = null;
    },
    onSuccess: (data) => {
      preview = (data?.compPreview as CompGiftPreview | undefined) ?? null;
    },
  });

  const compForm = new FormState({
    reset: false,
    onSubmit: ({ cancel }) => {
      // Enter in a text field submits the form; only the confirm button may comp.
      if (!confirming) return cancel();
    },
    onSuccess: (data) => {
      comped = (data?.comped as CompGiftResult | undefined) ?? null;
      reason = '';
      message = '';
    },
    // A second comp is a second gift, so every attempt starts from a fresh preview.
    onSettled: () => {
      confirming = false;
      preview = null;
    },
  });
</script>

<section id="membership-gift-comp" class="mb-4 rounded-xl border border-dark-4 bg-dark-6 p-5">
  <h3 class="mb-1 text-sm font-semibold text-white">Gift a membership</h3>
  <p class="mb-3 text-xs text-dark-2">
    A membership gift from you that nobody pays for. They are notified and emailed, and accept it
    themselves. 1 to {COMP_GIFT_MAX_MONTHS} months; {COMP_GIFT_DAILY_LIMIT} comps per moderator per day.
  </p>

  {#if previewForm.error}
    <ErrorAlert class="mb-3" message={previewForm.error} />
  {/if}
  {#if compForm.error}
    <ErrorAlert class="mb-3" message={compForm.error} />
  {/if}

  {#if comped}
    {@const r = comped}
    <div
      class="mb-3 rounded-md border border-green-500/30 bg-green-500/10 p-3 text-sm text-green-200"
      role="status"
    >
      Gifted {r.months} month{r.months === 1 ? '' : 's'} of {r.tier} to {r.recipient.username ?? r.recipient.id}.
      <span class="block text-xs">Gift {r.giftId}</span>
      {#if !r.fulfilled}
        <span class="block text-xs text-yellow-200">
          The gift exists but they were not notified yet. Do not comp again: ask an engineer to
          finish fulfilment for this gift.
        </span>
      {/if}
    </div>
  {/if}

  <form
    method="POST"
    action="?/previewCompGift"
    use:enhance={previewForm.enhance}
    class="space-y-2"
  >
    <input type="hidden" name="userId" value={userId} />
    <div class="flex items-end gap-2">
      <div>
        <Label for="cg-tier">Tier</Label>
        <select
          id="cg-tier"
          name="tier"
          bind:value={tier}
          class="mt-1 h-9 rounded-md border border-dark-4 bg-dark-7 px-2 text-sm text-white"
        >
          {#each COMP_GIFT_TIERS as t (t)}<option value={t}>{t}</option>{/each}
        </select>
      </div>
      <div>
        <Label for="cg-months">Months</Label>
        <Input
          id="cg-months"
          name="months"
          type="number"
          min={1}
          max={COMP_GIFT_MAX_MONTHS}
          bind:value={months}
          class="mt-1 w-24"
        />
      </div>
    </div>
    <div>
      <Label for="cg-reason">Reason (staff only)</Label>
      <Input
        id="cg-reason"
        name="reason"
        bind:value={reason}
        maxlength={500}
        placeholder="Why we are gifting this"
        class="mt-1"
      />
    </div>
    <div>
      <Label for="cg-message">Message to them (optional)</Label>
      <Input id="cg-message" name="message" bind:value={message} maxlength={500} class="mt-1" />
    </div>
    <label class="flex items-center gap-2 text-sm text-dark-2">
      <input type="checkbox" name="anonymous" bind:checked={anonymous} />
      Hide my name
    </label>
    <Button
      type="submit"
      variant="outline"
      disabled={!months || reason.trim().length < COMP_GIFT_REASON_MIN || previewForm.submitting}
    >
      Preview
    </Button>
  </form>

  {#if preview && previewCurrent}
    {@const p = preview}
    <div class="mt-3 text-sm text-dark-2">
      <div class="text-white">
        {p.months} month{p.months === 1 ? '' : 's'} of {p.tier} to {p.recipient.username ?? p.recipient.id}.
        Nothing is charged.
      </div>
      <div>{giftabilityText(p)}</div>
      <div class="text-xs">You have comped {p.compsInLast24h} in the last 24 hours.</div>
    </div>

    <form method="POST" action="?/compGift" use:enhance={compForm.enhance} class="mt-3">
      <input type="hidden" name="userId" value={userId} />
      <input type="hidden" name="tier" value={p.tier} />
      <input type="hidden" name="months" value={p.months} />
      <input type="hidden" name="reason" value={reason} />
      <input type="hidden" name="message" value={message} />
      {#if anonymous}<input type="hidden" name="anonymous" value="on" />{/if}
      <!-- Two steps: the recipient is notified at once and a comp is not undone from here. -->
      <div class="flex items-center gap-2">
        {#if confirming}
          <Button type="submit" disabled={!canComp || compForm.submitting}>
            Gift {p.months} month{p.months === 1 ? '' : 's'} of {p.tier}
          </Button>
          <Button type="button" variant="outline" onclick={() => (confirming = false)}>
            Cancel
          </Button>
        {:else}
          <Button type="button" disabled={!canComp} onclick={() => (confirming = true)}>
            Comp gift
          </Button>
        {/if}
      </div>
    </form>
  {/if}
</section>
