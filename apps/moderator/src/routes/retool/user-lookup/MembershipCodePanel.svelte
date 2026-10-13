<script lang="ts">
  import { enhance } from '$app/forms';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import { Label } from '@civitai/ui/components/ui/label/index.js';
  import * as Select from '@civitai/ui/components/ui/select/index.js';
  import { FormState } from '$lib/form-state.svelte';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';
  import { dateTime } from '$lib/format';

  let { userId, civitaiUrl }: { userId: number; civitaiUrl: string } = $props();

  const TIERS = [
    ['bronze', 'Bronze'],
    ['silver', 'Silver'],
    ['gold', 'Gold'],
  ] as const;
  const MONTHS = ['1', '2', '3', '4', '5', '6'];

  let tier = $state('');
  let months = $state('');
  let reason = $state('');
  let confirming = $state(false);

  type Minted = { code: string; expiresAt: string; tier: string; months: number };
  let minted = $state<Minted | null>(null);

  const tierLabel = $derived(TIERS.find(([v]) => v === tier)?.[1] ?? 'Choose a tier');

  // `reset: false` for the same reason as the Buzz form: `update()` would blank the inputs on screen
  // while their state kept the old values. Everything clears on success so the next mint starts empty.
  const form = new FormState({
    reset: false,
    onSubmit: () => (minted = null),
    onSuccess: (data) => {
      minted = (data?.minted as Minted | undefined) ?? null;
      tier = '';
      months = '';
      reason = '';
      confirming = false;
      copied = false;
    },
  });

  let copied = $state(false);
  const copy = async (code: string) => {
    await navigator.clipboard.writeText(code);
    copied = true;
  };
</script>

<section class="mb-4 rounded-xl border border-dark-4 bg-dark-6 p-5">
  <h3 class="mb-1 text-sm font-semibold text-white">Membership code</h3>
  <p class="mb-3 text-xs text-dark-2">
    Mints one redeem code for this customer to make them whole. Codes are Civitai memberships
    (yellow Buzz, claimed monthly by the customer), last up to 6 months, and expire unredeemed after
    30 days. At most 10 per moderator per day.
  </p>

  {#if form.error}
    <ErrorAlert class="mb-3" message={form.error} />
  {/if}

  {#if minted}
    <div
      class="mb-3 space-y-1 rounded-md border border-green-500/30 bg-green-500/10 p-3 text-sm text-green-200"
      role="status"
    >
      <div>
        {minted.months} month{minted.months === 1 ? '' : 's'} of {minted.tier}. Send the customer
        this code and {civitaiUrl}/redeem-code. It is shown once.
      </div>
      <div class="flex items-center gap-2">
        <code class="rounded bg-dark-7 px-2 py-1 font-mono text-white">{minted.code}</code>
        <Button size="sm" variant="outline" onclick={() => copy(minted!.code)}>
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <div class="text-xs">Expires {dateTime(minted.expiresAt)} if not redeemed.</div>
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
        <Select.Trigger id="mc-tier" class="mt-1 w-full">{tierLabel}</Select.Trigger>
        <Select.Content>
          {#each TIERS as [value, label] (value)}
            <Select.Item {value}>{label}</Select.Item>
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
          Mint {months} month{months === '1' ? '' : 's'} of {tierLabel}
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
</section>
