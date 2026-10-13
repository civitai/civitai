<script lang="ts">
  import { browser } from '$app/environment';
  import { enhance } from '$app/forms';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import { Label } from '@civitai/ui/components/ui/label/index.js';
  import * as Select from '@civitai/ui/components/ui/select/index.js';
  import { FormState } from '$lib/form-state.svelte';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';
  import { dateTime } from '$lib/format';
  import {
    MEMBERSHIP_CODE_DAILY_CAP,
    MEMBERSHIP_CODE_EXPIRY_DAYS,
    MEMBERSHIP_CODE_MAX_MONTHS,
    MEMBERSHIP_CODE_TIER_LABELS,
    MEMBERSHIP_CODE_TIERS,
    membershipCodeStatus,
    type MembershipCodeStatus,
    type MembershipCodeTier,
    type MintedMembershipCode,
  } from '$lib/membership-code';
  import { fetchMembershipCodes } from './membership-codes';

  let { userId, civitaiUrl }: { userId: number; civitaiUrl: string } = $props();

  const MONTHS = Array.from({ length: MEMBERSHIP_CODE_MAX_MONTHS }, (_, i) => String(i + 1));

  let tier = $state('');
  let months = $state('');
  let reason = $state('');
  let confirming = $state(false);
  let minted = $state<MintedMembershipCode | null>(null);
  let copyState = $state<'idle' | 'copied' | 'failed'>('idle');

  // Bumped after a mint or revoke so the list refetches; it comes from `/api/*`, not the page load.
  let version = $state(0);
  const codes = $derived(browser ? fetchMembershipCodes(userId, version) : null);
  let revoking = $state<string | null>(null);

  const STATUS_VARIANT: Record<MembershipCodeStatus, 'secondary' | 'outline' | 'destructive'> = {
    open: 'secondary',
    redeemed: 'outline',
    revoked: 'destructive',
    expired: 'outline',
  };

  const tierLabel = (t: string) => MEMBERSHIP_CODE_TIER_LABELS[t as MembershipCodeTier] ?? t;

  // `reset: false` for the same reason as the Buzz form: `update()` would blank the inputs on screen
  // while their state kept the old values.
  const form = new FormState({
    reset: false,
    onSubmit: ({ cancel }) => {
      // Enter in a text field submits the form; only the confirm step's button may mint.
      if (!confirming) return cancel();
      minted = null;
    },
    onSuccess: (data) => {
      minted = (data?.minted as MintedMembershipCode | undefined) ?? null;
      tier = '';
      months = '';
      reason = '';
      copyState = 'idle';
      revoke.error = null;
    },
    // After every answer, failures included: disarm, so a "may have minted" warning never sits above a
    // live confirm button, and refetch the list.
    onSettled: () => {
      confirming = false;
      version += 1;
    },
  });

  const revoke = new FormState({
    reset: false,
    onSuccess: null,
    // After any answer, including "could not confirm": the list is what tells the operator.
    onSettled: () => {
      revoking = null;
      version += 1;
    },
  });

  const copy = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      copyState = 'copied';
    } catch {
      copyState = 'failed';
    }
  };
</script>

<section class="mb-4 rounded-xl border border-dark-4 bg-dark-6 p-5">
  <h3 class="mb-1 text-sm font-semibold text-white">Membership code</h3>
  <p class="mb-3 text-xs text-dark-2">
    Mints one redeem code that only this account can redeem. Codes are Civitai memberships (yellow
    Buzz, claimed monthly by the customer), last up to {MEMBERSHIP_CODE_MAX_MONTHS} months, and expire
    unredeemed after {MEMBERSHIP_CODE_EXPIRY_DAYS} days. At most {MEMBERSHIP_CODE_DAILY_CAP} per moderator
    per day.
  </p>

  {#if form.error}
    <ErrorAlert class="mb-3" message={form.error} />
  {/if}

  {#if minted}
    {@const m = minted}
    <div
      class="mb-3 space-y-1 rounded-md border border-green-500/30 bg-green-500/10 p-3 text-sm text-green-200"
      role="status"
    >
      <div>
        {m.months} month{m.months === 1 ? '' : 's'} of {tierLabel(m.tier)}. Send the customer this
        code and {civitaiUrl}/redeem-code. It is shown once.
      </div>
      <div class="flex items-center gap-2">
        <code class="rounded bg-dark-7 px-2 py-1 font-mono text-white select-all">{m.code}</code>
        <Button size="sm" variant="outline" onclick={() => copy(m.code)}>
          {copyState === 'copied' ? 'Copied' : 'Copy'}
        </Button>
      </div>
      {#if copyState === 'failed'}
        <div class="text-xs text-amber-300">Copy failed; select the code and copy it by hand.</div>
      {/if}
      <div class="text-xs">Expires {dateTime(m.expiresAt)} if not redeemed.</div>
    </div>
  {/if}

  <form
    method="POST"
    action="?/mintMembershipCode"
    use:enhance={form.enhance}
    class="grid gap-3 sm:grid-cols-2"
  >
    <input type="hidden" name="userId" value={userId} />
    <div>
      <Label for="mc-tier">Tier</Label>
      <Select.Root type="single" name="tier" bind:value={tier}>
        <Select.Trigger id="mc-tier" class="mt-1 w-full">
          {tier ? tierLabel(tier) : 'Choose a tier'}
        </Select.Trigger>
        <Select.Content>
          {#each MEMBERSHIP_CODE_TIERS as value (value)}
            <Select.Item {value}>{tierLabel(value)}</Select.Item>
          {/each}
        </Select.Content>
      </Select.Root>
    </div>
    <div>
      <Label for="mc-months">Months</Label>
      <Select.Root type="single" name="months" bind:value={months}>
        <Select.Trigger id="mc-months" class="mt-1 w-full">{months || 'Choose'}</Select.Trigger>
        <Select.Content>
          {#each MONTHS as m (m)}
            <Select.Item value={m}>{m}</Select.Item>
          {/each}
        </Select.Content>
      </Select.Root>
    </div>
    <div class="sm:col-span-2">
      <Label for="mc-reason">Reason</Label>
      <Input
        id="mc-reason"
        name="reason"
        bind:value={reason}
        maxlength={500}
        placeholder="Ticket number and what went wrong"
        class="mt-1"
      />
    </div>
    <!-- Two steps: the code is worth real money and a mis-picked tier or month is not undoable. -->
    <div class="flex items-center gap-2 sm:col-span-2">
      {#if confirming}
        <Button type="submit" disabled={form.submitting}>
          Mint {months} month{months === '1' ? '' : 's'} of {tierLabel(tier)}
        </Button>
        <Button type="button" variant="outline" onclick={() => (confirming = false)}>Cancel</Button>
      {:else}
        <Button
          type="button"
          disabled={!tier || !months || !reason.trim()}
          onclick={() => (confirming = true)}
        >
          Mint code
        </Button>
      {/if}
    </div>
  </form>

  <h4 class="mt-5 mb-2 text-xs font-semibold text-white">Codes minted for this account</h4>
  {#if revoke.error}
    <ErrorAlert class="mb-2" message={revoke.error} />
  {/if}
  {#if codes}
    {#await codes}
      <p class="text-xs text-dark-2">Loading codes…</p>
    {:then rows}
      {#if rows.length === 0}
        <p class="text-xs text-dark-2">None.</p>
      {:else}
        <ul class="space-y-2 text-sm">
          {#each rows as row (row.code)}
            {@const status = membershipCodeStatus(row)}
            <li class="flex flex-wrap items-center gap-x-2 gap-y-1">
              <code class="font-mono text-white select-all">{row.code}</code>
              <span class="text-dark-2">
                {row.months} mo {row.tier ? tierLabel(row.tier) : ''} · {dateTime(row.createdAt)}
              </span>
              <Badge variant={STATUS_VARIANT[status]}>{status}</Badge>
              {#if status === 'open'}
                {#if revoking === row.code}
                  <form method="POST" action="?/revokeMembershipCode" use:enhance={revoke.enhance}>
                    <input type="hidden" name="userId" value={userId} />
                    <input type="hidden" name="code" value={row.code} />
                    <Button type="submit" size="sm" variant="destructive" disabled={revoke.submitting}>
                      Confirm revoke
                    </Button>
                  </form>
                  <Button size="sm" variant="outline" onclick={() => (revoking = null)}>Cancel</Button>
                {:else}
                  <Button size="sm" variant="outline" onclick={() => (revoking = row.code)}>
                    Revoke
                  </Button>
                {/if}
              {/if}
              {#if row.reason}
                <span class="w-full text-xs text-dark-2">{row.reason}</span>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    {:catch e}
      <ErrorAlert message={`Could not load this account's codes (${(e as Error).message}).`} />
      <Button size="sm" variant="outline" class="mt-2" onclick={() => (version += 1)}>Retry</Button>
    {/await}
  {/if}
</section>
