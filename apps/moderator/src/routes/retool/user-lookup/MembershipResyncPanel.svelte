<script lang="ts">
  import { enhance } from '$app/forms';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Checkbox } from '@civitai/ui/components/ui/checkbox/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import { Label } from '@civitai/ui/components/ui/label/index.js';
  import { FormState } from '$lib/form-state.svelte';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';
  import { dateTime } from '$lib/format';
  import {
    MEMBERSHIP_EXTEND_REASON_MIN,
    type MembershipResyncPreview,
    type MembershipResyncResult,
  } from '$lib/membership-extend';

  let { userId, initialReason = '' }: { userId: number; initialReason?: string } = $props();

  // Intentionally not reactive: seeded once from the proposal link.
  // svelte-ignore state_referenced_locally
  let reason = $state(initialReason);
  let preview = $state<MembershipResyncPreview | null>(null);
  let endBuzzConfirmed = $state(false);
  let resynced = $state<MembershipResyncResult | null>(null);

  const canResync = $derived(
    preview !== null &&
      preview.problems.length === 0 &&
      (!preview.endsBuzzMembership || endBuzzConfirmed) &&
      reason.trim().length >= MEMBERSHIP_EXTEND_REASON_MIN
  );

  const previewForm = new FormState({
    reset: false,
    onSubmit: () => {
      preview = null;
      resynced = null;
      endBuzzConfirmed = false;
      resyncForm.error = null;
    },
    onSuccess: (data) => {
      preview = (data?.resyncPreview as MembershipResyncPreview | undefined) ?? null;
    },
  });

  const resyncForm = new FormState({
    reset: false,
    onSuccess: (data) => {
      resynced = (data?.resynced as MembershipResyncResult | undefined) ?? null;
      reason = '';
    },
    onSettled: () => {
      preview = null;
      endBuzzConfirmed = false;
    },
  });

  const show = (v: string | boolean | null) =>
    v === null ? 'none' : typeof v === 'boolean' ? String(v) : v;
</script>

<section id="membership-resync" class="mb-4 rounded-xl border border-dark-4 bg-dark-6 p-5">
  <h3 class="mb-1 text-sm font-semibold text-white">Re-sync from Stripe</h3>
  <p class="mb-3 text-xs text-dark-2">
    Re-reads the member’s Stripe subscription into our record, for when a Stripe update was missed.
    Changes nothing in Stripe.
  </p>

  {#if previewForm.error}
    <ErrorAlert class="mb-3" message={previewForm.error} />
  {/if}
  {#if resyncForm.error}
    <ErrorAlert class="mb-3" message={resyncForm.error} />
  {/if}

  {#if resynced}
    <div
      class="mb-3 rounded-md border border-green-500/30 bg-green-500/10 p-3 text-sm text-green-200"
      role="status"
    >
      Re-synced: {resynced.changes.length
        ? `${resynced.changes.length} field${resynced.changes.length === 1 ? '' : 's'} updated`
        : 'already matched'}.
      {#if resynced.after}
        Now {resynced.after.status}, period ends
        {dateTime(resynced.after.currentPeriodEnd ?? null)}.
      {:else}
        The row could not be read back; refresh to check it.
      {/if}
      {#if resynced.endedBuzzMembership}
        <span class="block text-xs">
          Ended the Buzz-bought membership {resynced.endedBuzzMembership.id}.
        </span>
      {/if}
    </div>
  {/if}

  <form method="POST" action="?/previewMembershipResync" use:enhance={previewForm.enhance}>
    <input type="hidden" name="userId" value={userId} />
    <Button type="submit" variant="outline" disabled={previewForm.submitting}>Preview</Button>
  </form>

  {#if preview}
    {@const p = preview}
    <div class="mt-3 text-sm text-dark-2">
      {#if p.problems.length}
        <ul class="list-disc pl-5 text-red-300">
          {#each p.problems as problem (problem)}<li>{problem}</li>{/each}
        </ul>
      {:else if p.changes.length === 0}
        <div class="text-white">Our record already matches Stripe.</div>
      {:else}
        <table class="text-xs">
          <thead>
            <tr class="text-left">
              <th class="pr-4">Field</th><th class="pr-4">Ours</th><th>Stripe</th>
            </tr>
          </thead>
          <tbody>
            {#each p.changes as c (c.field)}
              <tr>
                <td class="pr-4">{c.field}</td>
                <td class="pr-4">{show(c.ours)}</td>
                <td class="text-white">{show(c.stripe)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}
    </div>

    {#if p.problems.length === 0}
      <form
        method="POST"
        action="?/resyncMembership"
        use:enhance={resyncForm.enhance}
        class="mt-3 space-y-2"
      >
        <input type="hidden" name="userId" value={userId} />
        {#if p.endsBuzzMembership}
          <label
            data-touch-target
            class="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-200"
          >
            <Checkbox
              name="confirmEndBuzzMembership"
              value={p.endsBuzzMembership.confirm}
              bind:checked={endBuzzConfirmed}
              class="mt-1"
            />
            <span>
              This will end the member’s Buzz-bought membership {p.endsBuzzMembership.id}
              ({p.endsBuzzMembership.status}, paid to {dateTime(p.endsBuzzMembership.currentPeriodEnd)}).
              No Buzz is refunded.
            </span>
          </label>
        {/if}
        <div>
          <Label for="mr-reason">Reason</Label>
          <Input
            id="mr-reason"
            name="reason"
            bind:value={reason}
            maxlength={500}
            placeholder="Ticket number and what is out of sync"
            class="mt-1"
          />
        </div>
        <Button type="submit" disabled={!canResync || resyncForm.submitting}>Re-sync</Button>
      </form>
    {/if}
  {/if}
</section>
