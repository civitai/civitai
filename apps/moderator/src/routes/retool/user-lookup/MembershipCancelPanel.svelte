<script lang="ts">
  import { enhance } from '$app/forms';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import { Label } from '@civitai/ui/components/ui/label/index.js';
  import { FormState } from '$lib/form-state.svelte';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';
  import { dateTime } from '$lib/format';
  import {
    MEMBERSHIP_EXTEND_REASON_MIN,
    type MembershipCancelPreview,
    type MembershipCancelResult,
  } from '$lib/membership-extend';

  let {
    userId,
    initialCancel = '',
    initialReason = '',
  }: { userId: number; initialCancel?: string; initialReason?: string } = $props();

  // Seeded once from the assistant's proposal link; the operator previews and confirms.
  // svelte-ignore state_referenced_locally
  let reason = $state(initialReason);
  let preview = $state<MembershipCancelPreview | null>(null);
  let confirming = $state(false);
  let changed = $state<MembershipCancelResult | null>(null);

  const canChange = $derived(
    preview !== null &&
      preview.problems.length === 0 &&
      preview.changed === true &&
      reason.trim().length >= MEMBERSHIP_EXTEND_REASON_MIN
  );

  const previewForm = new FormState({
    reset: false,
    onSubmit: () => {
      preview = null;
      changed = null;
      confirming = false;
      changeForm.error = null;
    },
    onSuccess: (data) => {
      preview = (data?.cancelPreview as MembershipCancelPreview | undefined) ?? null;
    },
  });

  const changeForm = new FormState({
    reset: false,
    onSubmit: ({ cancel }) => {
      // Enter in the reason field submits the form; only the confirm button may change it.
      if (!confirming) return cancel();
    },
    onSuccess: (data) => {
      changed = (data?.cancelChanged as MembershipCancelResult | undefined) ?? null;
      reason = '';
    },
    onSettled: () => {
      confirming = false;
      preview = null;
    },
  });
</script>

<section id="membership-cancel" class="mb-4 rounded-xl border border-dark-4 bg-dark-6 p-5">
  <h3 class="mb-1 text-sm font-semibold text-white">Cancel at period end</h3>
  <p class="mb-3 text-xs text-dark-2">
    Sets or undoes a Stripe member’s cancel at the end of the paid period, when they ask. Nothing is
    charged or refunded now; undoing it means they are charged at renewal.
  </p>

  {#if previewForm.error}
    <ErrorAlert class="mb-3" message={previewForm.error} />
  {/if}
  {#if changeForm.error}
    <ErrorAlert class="mb-3" message={changeForm.error} />
  {/if}

  {#if changed}
    {@const r = changed}
    {#if r.ok}
      <div
        class="mb-3 rounded-md border border-green-500/30 bg-green-500/10 p-3 text-sm text-green-200"
        role="status"
      >
        {#if !r.changed}
          Already {r.cancelAtPeriodEnd ? 'set to cancel' : 'renewing'}; nothing was changed.
        {:else if r.cancelAtPeriodEnd}
          Set to cancel on {dateTime(r.after?.currentPeriodEnd ?? null)}.
        {:else}
          Cancel undone: renews on {dateTime(r.after?.currentPeriodEnd ?? null)}.
        {/if}
        <span class="block text-xs">The Subscription panel shows it once Stripe syncs.</span>
      </div>
    {:else}
      <div class="mb-3 rounded-md border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-200">
        {#if r.written === true}
          Stripe was changed, but the check afterwards failed. Open the subscription in Stripe first.
        {:else if r.written === false}
          Stripe refused the change; nothing was written.
        {:else}
          Stripe did not answer; the change may or may not have happened. Open the subscription in
          Stripe.
        {/if}
        <ul class="mt-1 list-disc pl-5 text-xs">
          {#each r.problems as p (p)}<li>{p}</li>{/each}
        </ul>
      </div>
    {/if}
  {/if}

  <form
    method="POST"
    action="?/previewMembershipCancel"
    use:enhance={previewForm.enhance}
    class="flex items-end gap-2"
  >
    <input type="hidden" name="userId" value={userId} />
    <Button
      type="submit"
      name="cancelAtPeriodEnd"
      value="true"
      variant={initialCancel === 'true' ? 'default' : 'outline'}
      disabled={previewForm.submitting}
    >
      Preview: cancel at period end
    </Button>
    <Button
      type="submit"
      name="cancelAtPeriodEnd"
      value="false"
      variant={initialCancel === 'false' ? 'default' : 'outline'}
      disabled={previewForm.submitting}
    >
      Preview: undo cancel
    </Button>
  </form>

  {#if preview}
    {@const p = preview}
    <div class="mt-3 text-sm text-dark-2">
      {#if p.subscription}
        <div>
          Stripe: {p.subscription.status}, period ends {dateTime(p.subscription.currentPeriodEnd)},
          {p.subscription.cancelAtPeriodEnd ? 'set to cancel' : 'renewing'}
        </div>
      {/if}
      {#if p.problems.length}
        <ul class="mt-1 list-disc pl-5 text-red-300">
          {#each p.problems as problem (problem)}<li>{problem}</li>{/each}
        </ul>
      {:else if p.changed === false}
        <div class="text-white">Already {p.cancelAtPeriodEnd ? 'set to cancel' : 'renewing'}.</div>
      {:else if p.cancelAtPeriodEnd}
        <div class="text-white">
          Cancels on {dateTime(p.subscription?.currentPeriodEnd ?? null)}; no further charge.
        </div>
      {:else}
        <div class="text-white">
          Renews on {dateTime(p.subscription?.currentPeriodEnd ?? null)}, and the member’s card is charged
          then.
        </div>
      {/if}
    </div>

    {#if p.problems.length === 0 && p.changed === true}
      <form
        method="POST"
        action="?/setMembershipCancel"
        use:enhance={changeForm.enhance}
        class="mt-3 space-y-2"
      >
        <input type="hidden" name="userId" value={userId} />
        <input type="hidden" name="cancelAtPeriodEnd" value={String(p.cancelAtPeriodEnd)} />
        <div>
          <Label for="mc-reason">Reason</Label>
          <Input
            id="mc-reason"
            name="reason"
            bind:value={reason}
            maxlength={500}
            placeholder="Ticket number and what the member asked for"
            class="mt-1"
          />
        </div>
        <!-- Two steps: this changes a real Stripe subscription. -->
        <div class="flex items-center gap-2">
          {#if confirming}
            <Button type="submit" disabled={!canChange || changeForm.submitting}>
              {p.cancelAtPeriodEnd ? 'Set to cancel' : 'Undo cancel'}
            </Button>
            <Button type="button" variant="outline" onclick={() => (confirming = false)}>
              Back
            </Button>
          {:else}
            <Button type="button" disabled={!canChange} onclick={() => (confirming = true)}>
              {p.cancelAtPeriodEnd ? 'Cancel at period end' : 'Undo cancel'}
            </Button>
          {/if}
        </div>
      </form>
    {/if}
  {/if}
</section>
