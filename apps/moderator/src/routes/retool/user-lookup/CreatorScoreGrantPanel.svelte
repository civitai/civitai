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
    CREATOR_SCORE_GRANT_MAX_AMOUNT,
    CREATOR_SCORE_GRANT_REASON_MAX,
  } from '$lib/creator-score-grant';
  import { fetchCreatorScoreGrants } from './creator-score-grants';

  let { userId }: { userId: number } = $props();

  let amount = $state('');
  let reason = $state('');
  let confirming = $state(false);
  let granted = $state<{ amount: number; total: number } | null>(null);

  // Bumped after a grant or revoke so the list refetches; it comes from `/api/*`, not the page load.
  let version = $state(0);
  const grants = $derived(browser ? fetchCreatorScoreGrants(userId, version) : null);
  let revoking = $state<number | null>(null);
  let revokeReason = $state('');

  const amountValue = $derived(Number(amount));
  const amountValid = $derived(
    Number.isInteger(amountValue) && amountValue >= 1 && amountValue <= CREATOR_SCORE_GRANT_MAX_AMOUNT
  );

  // `reload`: the Reputation panel's total comes from the page load, so it must re-run to show the new
  // score. `reset: false` so the inputs are cleared through their state, not behind it.
  const form = new FormState({
    reload: true,
    reset: false,
    onSubmit: ({ cancel }) => {
      // Enter in a text field submits the form; only the confirm step's button may grant.
      if (!confirming) return cancel();
      granted = null;
    },
    onSuccess: (data) => {
      granted = (data?.granted as { amount: number; total: number } | undefined) ?? null;
      amount = '';
      reason = '';
      revoke.error = null;
    },
    // After every answer, failures included: disarm, so a "could not confirm" warning never sits above
    // a live confirm button, and refetch the list.
    onSettled: () => {
      confirming = false;
      version += 1;
    },
  });

  const revoke = new FormState({
    reload: true,
    reset: false,
    onSuccess: () => {
      form.error = null;
    },
    // After any answer, including "could not confirm": the list is what tells the operator.
    onSettled: () => {
      revoking = null;
      revokeReason = '';
      version += 1;
    },
  });
</script>

<section class="mb-4 rounded-xl border border-dark-4 bg-dark-6 p-5">
  <h3 class="mb-1 text-sm font-semibold text-white">Grant Creator Score</h3>
  <p class="mb-3 text-xs text-dark-2">
    Adds points to this account's Creator Score as "Staff awarded", which the owner sees in their
    score breakdown. They do not see the reason. Up to {num(CREATOR_SCORE_GRANT_MAX_AMOUNT)} points per
    grant, at most {CREATOR_SCORE_GRANT_DAILY_CAP} grants per moderator per day. A revoke takes the points
    back; a tier the grant already earned stays earned.
  </p>

  {#if form.error}
    <ErrorAlert class="mb-3" message={form.error} />
  {/if}

  {#if granted}
    <div
      class="mb-3 rounded-md border border-green-500/30 bg-green-500/10 p-3 text-sm text-green-200"
      role="status"
    >
      Granted {num(granted.amount)} points. Creator Score is now {num(granted.total)}.
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
        max={CREATOR_SCORE_GRANT_MAX_AMOUNT}
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
    <!-- Two steps: the points move a creator's tier, and a mistyped amount is only undone by a revoke. -->
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

  <h4 class="mt-5 mb-2 text-xs font-semibold text-white">Grants on this account</h4>
  {#if revoke.error}
    <ErrorAlert class="mb-2" message={revoke.error} />
  {/if}
  {#if grants}
    {#await grants}
      <p class="text-xs text-dark-2">Loading grants…</p>
    {:then rows}
      {#if rows.length === 0}
        <p class="text-xs text-dark-2">None.</p>
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
