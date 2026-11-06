<script lang="ts">
  import { enhance } from '$app/forms';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import { Label } from '@civitai/ui/components/ui/label/index.js';
  import { FormState } from '$lib/form-state.svelte';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';
  import { dateTime } from '$lib/format';
  import {
    MEMBERSHIP_EXTEND_COOLDOWN_DAYS,
    MEMBERSHIP_EXTEND_MAX_DAYS,
    MEMBERSHIP_EXTEND_REASON_MIN,
    type MembershipExtensionPreview,
    type MembershipExtensionResult,
  } from '$lib/membership-extend';

  let {
    userId,
    initialDays = '',
    initialReason = '',
  }: { userId: number; initialDays?: string; initialReason?: string } = $props();

  // Seeded once from the assistant's proposal link; the operator edits from there.
  // svelte-ignore state_referenced_locally
  let days = $state(initialDays);
  // svelte-ignore state_referenced_locally
  let reason = $state(initialReason);
  let preview = $state<MembershipExtensionPreview | null>(null);
  let confirming = $state(false);
  let extended = $state<MembershipExtensionResult | null>(null);

  // A preview answers for the days it was asked about; changing them makes it stale.
  const previewCurrent = $derived(preview !== null && String(preview.days) === String(days));
  const canExtend = $derived(
    previewCurrent &&
      preview!.problems.length === 0 &&
      preview!.expectedCurrentPeriodEnd !== null &&
      reason.trim().length >= MEMBERSHIP_EXTEND_REASON_MIN
  );

  const previewForm = new FormState({
    reset: false,
    onSubmit: () => {
      preview = null;
      extended = null;
      confirming = false;
      extendForm.error = null;
    },
    onSuccess: (data) => {
      preview = (data?.extendPreview as MembershipExtensionPreview | undefined) ?? null;
    },
  });

  const extendForm = new FormState({
    reset: false,
    onSubmit: ({ cancel }) => {
      // Enter in the reason field submits the form; only the confirm button may extend.
      if (!confirming) return cancel();
    },
    onSuccess: (data) => {
      extended = (data?.extended as MembershipExtensionResult | undefined) ?? null;
      reason = '';
    },
    // After every answer, failures included: the preview's CAS value is spent either way, so the next
    // attempt must start from a fresh preview.
    onSettled: () => {
      confirming = false;
      preview = null;
    },
  });
</script>

<section id="membership-extend" class="mb-4 rounded-xl border border-dark-4 bg-dark-6 p-5">
  <h3 class="mb-1 text-sm font-semibold text-white">Extend membership</h3>
  <p class="mb-3 text-xs text-dark-2">
    Gives a Stripe member free days: the next charge, or the cancel, moves out by that many days.
    Monthly plans only, 1 to {MEMBERSHIP_EXTEND_MAX_DAYS} days, once per member in {MEMBERSHIP_EXTEND_COOLDOWN_DAYS} days.
  </p>

  {#if previewForm.error}
    <ErrorAlert class="mb-3" message={previewForm.error} />
  {/if}
  {#if extendForm.error}
    <ErrorAlert class="mb-3" message={extendForm.error} />
  {/if}

  {#if extended}
    {@const r = extended}
    {#if r.ok}
      <div
        class="mb-3 rounded-md border border-green-500/30 bg-green-500/10 p-3 text-sm text-green-200"
        role="status"
      >
        Extended {r.days} day{r.days === 1 ? '' : 's'}. Now {r.after?.status}, next {r.mode ===
        'cancelling'
          ? 'cancel'
          : 'charge'}
        {dateTime(r.trialEnd)} (was {dateTime(r.before.currentPeriodEnd)}).
        {#if r.newInvoiceId}<span class="block text-xs">$0 invoice {r.newInvoiceId}</span>{/if}
        <span class="block text-xs">The Subscription panel shows the new end once Stripe syncs.</span>
      </div>
    {:else}
      <div class="mb-3 rounded-md border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-200">
        {#if r.written === true}
          Stripe was changed, but the check afterwards failed. Do not retry: open the subscription in
          Stripe first.
        {:else if r.written === false}
          Stripe refused the change; nothing was written. Preview again once the problem below is
          resolved.
        {:else}
          Stripe did not answer; the change may or may not have happened. Open the subscription in
          Stripe. A retry is refused for {MEMBERSHIP_EXTEND_COOLDOWN_DAYS} days either way.
        {/if}
        <ul class="mt-1 list-disc pl-5 text-xs">
          {#each r.problems as p (p)}<li>{p}</li>{/each}
        </ul>
      </div>
    {/if}
  {/if}

  <form
    method="POST"
    action="?/previewMembershipExtension"
    use:enhance={previewForm.enhance}
    class="flex items-end gap-2"
  >
    <input type="hidden" name="userId" value={userId} />
    <div>
      <Label for="me-days">Days</Label>
      <Input
        id="me-days"
        name="days"
        type="number"
        min={1}
        max={MEMBERSHIP_EXTEND_MAX_DAYS}
        bind:value={days}
        class="mt-1 w-24"
      />
    </div>
    <Button type="submit" variant="outline" disabled={!days || previewForm.submitting}>
      Preview
    </Button>
  </form>

  {#if preview && previewCurrent}
    {@const p = preview}
    <div class="mt-3 text-sm text-dark-2">
      {#if p.subscription}
        <div>
          Stripe: {p.subscription.status}, period ends {dateTime(p.subscription.currentPeriodEnd)}
          {#if p.subscription.cancelAtPeriodEnd}(set to cancel){/if}
        </div>
      {/if}
      {#if p.problems.length}
        <ul class="mt-1 list-disc pl-5 text-red-300">
          {#each p.problems as problem (problem)}<li>{problem}</li>{/each}
        </ul>
      {:else}
        <div class="text-white">
          {p.days} day{p.days === 1 ? '' : 's'}: next {p.mode === 'cancelling' ? 'cancel' : 'charge'}
          moves to {dateTime(p.trialEndIso)}. Nothing is charged now.
        </div>
      {/if}
    </div>

    {#if p.problems.length === 0}
      <form
        method="POST"
        action="?/extendMembership"
        use:enhance={extendForm.enhance}
        class="mt-3 space-y-2"
      >
        <input type="hidden" name="userId" value={userId} />
        <input type="hidden" name="days" value={p.days} />
        <input type="hidden" name="expectedCurrentPeriodEnd" value={p.expectedCurrentPeriodEnd} />
        <div>
          <Label for="me-reason">Reason</Label>
          <Input
            id="me-reason"
            name="reason"
            bind:value={reason}
            maxlength={500}
            placeholder="Ticket number and what went wrong"
            class="mt-1"
          />
        </div>
        <!-- Two steps: this moves a real Stripe subscription and is not undone automatically. -->
        <div class="flex items-center gap-2">
          {#if confirming}
            <Button type="submit" disabled={!canExtend || extendForm.submitting}>
              Extend {p.days} day{p.days === 1 ? '' : 's'}
            </Button>
            <Button type="button" variant="outline" onclick={() => (confirming = false)}>
              Cancel
            </Button>
          {:else}
            <Button type="button" disabled={!canExtend} onclick={() => (confirming = true)}>
              Extend
            </Button>
          {/if}
        </div>
      </form>
    {/if}
  {/if}
</section>
