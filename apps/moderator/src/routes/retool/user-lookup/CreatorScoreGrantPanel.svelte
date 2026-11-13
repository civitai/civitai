<script lang="ts">
  import { browser } from '$app/environment';
  import { enhance } from '$app/forms';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import { Label } from '@civitai/ui/components/ui/label/index.js';
  import { FormState } from '$lib/form-state.svelte';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';
  import { dateTime, num } from '$lib/format';
  import {
    CREATOR_SCORE_GRANT_DAILY_CAP,
    CREATOR_SCORE_GRANT_REASON_MAX,
    type CreatorScoreGrantResult,
  } from '$lib/creator-score-grant';
  import { fetchCreatorScoreGrants } from './creator-score-grants';

  // The page passes the larger ceiling to holders of `user.creatorScore.grantLarge`.
  let { userId, maxAmount }: { userId: number; maxAmount: number } = $props();

  let amount = $state('');
  let reason = $state('');
  let confirming = $state(false);
  // The endpoint's own total: the Reputation panel above reads a replica that can lag.
  let outcome = $state<CreatorScoreGrantResult | null>(null);

  // Bump to refetch the list. It comes from `/api/*`, so the form's invalidateAll does not reach it.
  let version = $state(0);
  const grants = $derived(browser ? fetchCreatorScoreGrants(userId, version) : null);
  let revoking = $state<number | null>(null);
  let revokeReason = $state('');

  const amountValue = $derived(Number(amount));
  const amountValid = $derived(
    Number.isInteger(amountValue) && amountValue >= 1 && amountValue <= maxAmount
  );

  // reload: the Reputation panel's score comes from the page load. reset: false: the inputs are bound
  // state, cleared in onSuccess, and the native form reset would desync them.
  const form = new FormState({
    reload: true,
    reset: false,
    onSubmit: ({ cancel }) => {
      // Enter in a text field submits the form; only the confirm step's button may grant.
      if (!confirming) return cancel();
      outcome = null;
    },
    onSuccess: (data) => {
      outcome = (data?.outcome as CreatorScoreGrantResult | undefined) ?? null;
      amount = '';
      reason = '';
      revoke.error = null;
    },
    // Runs on failures too: disarm so an error never sits over a live confirm button, and refetch.
    onSettled: () => {
      confirming = false;
      version += 1;
    },
  });

  const revoke = new FormState({
    reload: true,
    reset: false,
    onSubmit: () => {
      outcome = null;
    },
    onSuccess: (data) => {
      outcome = (data?.outcome as CreatorScoreGrantResult | undefined) ?? null;
      form.error = null;
      revoking = null;
      revokeReason = '';
    },
    // Refetch on failures too (a lost response may have committed). Closing the row stays in onSuccess
    // so a refusal can be fixed and resubmitted.
    onSettled: () => {
      version += 1;
    },
  });
</script>

<section class="mb-4 rounded-xl border border-dark-4 bg-dark-6 p-5">
  <h3 class="mb-1 text-sm font-semibold text-white">Grant Creator Score</h3>
  <p class="mb-3 text-xs text-dark-2">
    Adds points to this account's Creator Score as "Staff awarded", which the owner sees in their
    score breakdown. They do not see the reason. Up to {num(maxAmount)} points per
    grant, at most {CREATOR_SCORE_GRANT_DAILY_CAP} grants per moderator per day. A revoke takes the points
    back; a tier the grant already earned stays earned.
  </p>

  {#if form.error}
    <ErrorAlert class="mb-3" message={form.error} />
  {/if}

  {#if outcome}
    <div
      class="mb-3 rounded-md border border-green-500/30 bg-green-500/10 p-3 text-sm text-green-200"
      role="status"
    >
      {outcome.kind === 'granted' ? `Granted ${num(outcome.amount)} points.` : 'Grant revoked.'}
      Creator Score is now {num(outcome.total)}.
    </div>
  {/if}

  <form
    method="POST"
    action="?/grantCreatorScore"
    use:enhance={form.enhance}
    class="grid gap-3 sm:grid-cols-[10rem_1fr]"
  >
    <input type="hidden" name="userId" value={userId} />
    <div>
      <Label for="csg-amount">Points</Label>
      <Input
        id="csg-amount"
        name="amount"
        type="number"
        min={1}
        max={maxAmount}
        step={1}
        bind:value={amount}
        class="mt-1"
      />
    </div>
    <div>
      <Label for="csg-reason">Reason</Label>
      <Input
        id="csg-reason"
        name="reason"
        bind:value={reason}
        maxlength={CREATOR_SCORE_GRANT_REASON_MAX}
        placeholder="Why, for the audit trail"
        class="mt-1"
      />
    </div>
    <!-- Two steps: a mistyped amount can only be undone by a revoke. -->
    <div class="flex items-center gap-2 sm:col-span-2">
      {#if confirming}
        <Button type="submit" disabled={form.submitting}>Grant {num(amountValue)} points</Button>
        <Button type="button" variant="outline" onclick={() => (confirming = false)}>Cancel</Button>
      {:else}
        <Button
          type="button"
          disabled={!amountValid || !reason.trim()}
          onclick={() => (confirming = true)}
        >
          Grant points
        </Button>
      {/if}
    </div>
  </form>

  <div class="mt-5 mb-2 flex items-center justify-between">
    <h4 class="text-xs font-semibold text-white">Grants on this account</h4>
    <!-- Manual refetch: after "could not confirm", a write can commit after the automatic refetch. -->
    <Button size="sm" variant="ghost" onclick={() => (version += 1)}>Refresh</Button>
  </div>
  {#if revoke.error}
    <ErrorAlert class="mb-2" message={revoke.error} />
  {/if}
  {#if grants}
    {#await grants}
      <p class="text-xs text-dark-2">Loading grants…</p>
    {:then rows}
      {#if rows.length === 0}
        <p class="text-xs text-dark-2">No Creator Score grants on this account.</p>
      {:else}
        <ul class="space-y-3 text-sm">
          {#each rows as row (row.id)}
            <li class="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span class="font-semibold tabular-nums text-white">+{num(row.amount)}</span>
              <span class="text-dark-2">
                {dateTime(row.createdAt)} · by {row.grantedBy ?? 'a deleted account'}
              </span>
              {#if row.revokedAt}
                <Badge variant="destructive">revoked</Badge>
              {:else}
                <Badge variant="secondary">active</Badge>
                {#if revoking !== row.id}
                  <Button
                    size="sm"
                    variant="outline"
                    onclick={() => {
                      revoking = row.id;
                      revokeReason = '';
                    }}
                  >
                    Revoke
                  </Button>
                {/if}
              {/if}
              <span class="w-full text-xs text-dark-2">{row.reason}</span>
              {#if row.revokedAt}
                <span class="w-full text-xs text-dark-2">
                  Revoked {dateTime(row.revokedAt)} by {row.revokedBy ?? 'a deleted account'}{row.revokeReason
                    ? `: ${row.revokeReason}`
                    : ''}
                </span>
              {:else if revoking === row.id}
                <form
                  method="POST"
                  action="?/revokeCreatorScoreGrant"
                  use:enhance={revoke.enhance}
                  class="flex w-full flex-wrap items-center gap-2"
                >
                  <input type="hidden" name="userId" value={userId} />
                  <input type="hidden" name="grantId" value={row.id} />
                  <Input
                    name="reason"
                    bind:value={revokeReason}
                    maxlength={CREATOR_SCORE_GRANT_REASON_MAX}
                    placeholder="Why it is being revoked"
                    aria-label="Revoke reason"
                    class="max-w-md flex-1"
                  />
                  <Button
                    type="submit"
                    size="sm"
                    variant="destructive"
                    disabled={revoke.submitting || !revokeReason.trim()}
                  >
                    Confirm revoke
                  </Button>
                  <Button type="button" size="sm" variant="outline" onclick={() => (revoking = null)}>
                    Cancel
                  </Button>
                </form>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    {:catch e}
      <ErrorAlert message={`Could not load this account's grants (${(e as Error).message}).`} />
      <Button size="sm" variant="outline" class="mt-2" onclick={() => (version += 1)}>Retry</Button>
    {/await}
  {/if}
</section>
