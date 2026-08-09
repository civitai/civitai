<script lang="ts">
  import { applyAction, enhance } from '$app/forms';
  import { invalidateAll } from '$app/navigation';
  import type { ActionResult } from '@sveltejs/kit';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import * as DropdownMenu from '@civitai/ui/components/ui/dropdown-menu/index.js';
  import * as Select from '@civitai/ui/components/ui/select/index.js';
  import type { LayoutData } from './$types';
  import { dateTime, num } from '$lib/format';
  import type { Account } from './user-account';
  import type { FormResult } from './form-result';
  import { BUZZ_TRANSACTION_TYPES } from './enforcement-options';

  type Subscription = NonNullable<LayoutData['result']>['subscription'];

  // Balance AND lifetime per colour, as Retool showed. Built here rather than inline so the tuple
  // doesn't infer as `string | number`.
  const balanceRows = (buzz: NonNullable<Account['buzz']>) => [
    { label: 'Yellow', balance: buzz.balance, lifetime: buzz.lifetimeBalance },
    { label: 'Blue', balance: buzz.blue, lifetime: buzz.blueLifetime },
    { label: 'Green', balance: buzz.green, lifetime: buzz.greenLifetime },
  ];

  let {
    subscription,
    account,
    userId,
    canAct,
    form,
  }: {
    subscription: Subscription;
    account: Promise<Account> | null;
    userId: number;
    canAct: boolean;
    form: FormResult;
  } = $props();

  const error = $derived(form?.scope === 'buzz' ? form.error : null);

  // Retool's BuzzTransferPopulate dropdown — canned amount, colour and description per label. These
  // exist in no query; they were widget config, and moderators use them daily.
  // `transactionType` is the LEDGER LABEL — see BUZZ_TRANSACTION_TYPES. Each preset carries the one
  // that matches what it is for; without it a chargeback retrieval files as a tip.
  const PRESETS = [
    {
      label: 'Stripe Chargeback Retrieval',
      amount: '',
      buzzType: 'yellow',
      action: 'deduct',
      transactionType: 'chargeback',
    },
    {
      label: 'Stripe Refund',
      amount: '',
      buzzType: 'yellow',
      action: 'deduct',
      transactionType: 'refund',
    },
    {
      label: '1st Place Stream Bingo',
      amount: '5000',
      buzzType: 'yellow',
      action: 'send',
      transactionType: 'reward',
    },
    {
      label: '2nd Place Stream Bingo',
      amount: '2500',
      buzzType: 'yellow',
      action: 'send',
      transactionType: 'reward',
    },
    {
      label: '3rd Place Stream Bingo',
      amount: '1000',
      buzzType: 'yellow',
      action: 'send',
      transactionType: 'reward',
    },
  ];

  let sending = $state(false);
  let submitting = $state(false);
  let amount = $state('');
  let description = $state('');
  let buzzType = $state('yellow');
  let action = $state('send');
  let transactionType = $state('compensation');

  const applyPreset = (p: (typeof PRESETS)[number]) => {
    amount = p.amount;
    description = p.label;
    buzzType = p.buzzType;
    action = p.action;
    transactionType = p.transactionType;
  };

  const afterAction =
    () =>
    async ({ result }: { result: ActionResult }) => {
      await applyAction(result);
      if (result.type === 'success') {
        sending = false;
        amount = '';
        description = '';
        await invalidateAll();
      }
      submitting = false;
    };

  const onSubmit = () => {
    submitting = true;
    return afterAction();
  };
</script>

<section class="mb-4 rounded-xl border border-dark-4 bg-dark-6 p-5">
  <h3 class="mb-3 text-sm font-semibold text-white">Subscription &amp; Buzz</h3>

  <div class="grid gap-5 lg:grid-cols-2">
    <div>
      <h4 class="mb-2 text-xs tracking-wide text-dark-2 uppercase">Subscription</h4>
      {#if !subscription}
        <p class="text-sm text-dark-2">No subscription on record.</p>
      {:else}
        <div class="flex flex-wrap items-baseline gap-x-2 text-sm">
          <span class="font-medium text-white">{subscription.productName ?? 'Unknown plan'}</span>
          <Badge variant={subscription.status === 'active' ? 'secondary' : 'destructive'}>
            {subscription.status}
          </Badge>
          {#if subscription.provider}
            <span class="text-xs text-dark-2">via {subscription.provider}</span>
          {/if}
        </div>
        <dl class="mt-2 space-y-0.5 text-sm text-dark-2">
          <div>Renews / ends: {dateTime(subscription.currentPeriodEnd)}</div>
          {#if subscription.cancelAtPeriodEnd}
            <div class="text-amber-300">Set to cancel at period end</div>
          {/if}
          {#if subscription.canceledAt}
            <div>Cancelled: {dateTime(subscription.canceledAt)}</div>
          {/if}
        </dl>
      {/if}
    </div>

    <div>
      <h4 class="mb-2 text-xs tracking-wide text-dark-2 uppercase">Buzz</h4>
      {#await account}
        <p class="text-sm text-dark-2">Loading balance…</p>
      {:then result}
        {#if !result}
          <p class="text-sm text-dark-2">Loading balance…</p>
        {:else if !result.buzz}
          <p class="text-sm text-dark-2">Balance unavailable.</p>
        {:else}
          <div class="flex flex-wrap gap-6">
            {#each balanceRows(result.buzz) as row (row.label)}
              <div>
                <div class="text-xl font-semibold tabular-nums text-white">
                  {row.balance === null ? '—' : num(row.balance)}
                </div>
                <div class="text-xs text-dark-2">{row.label}</div>
                <div class="text-xs tabular-nums text-dark-2">
                  lifetime {row.lifetime === null ? '—' : num(row.lifetime)}
                </div>
              </div>
            {/each}
          </div>
        {/if}
      {:catch}
        <p class="text-sm text-red-300">Could not load Buzz balance.</p>
      {/await}

      {#if canAct}
        {#if error}
          <div
            class="mt-3 rounded-md border border-red-500/30 bg-red-500/10 p-2 text-sm text-red-300"
            role="alert"
          >
            {error}
          </div>
        {/if}

        {#if !sending}
          <Button size="sm" class="mt-3" onclick={() => (sending = true)}>Send / deduct Buzz</Button>
        {:else}
          <form method="POST" action="?/sendBuzz" use:enhance={onSubmit} class="mt-3">
            <input type="hidden" name="userId" value={userId} />

            <!-- Retool drove these from splitButton1 — one control, not five buttons. -->
            <DropdownMenu.Root>
              <DropdownMenu.Trigger>
                {#snippet child({ props })}
                  <Button {...props} type="button" size="sm" variant="outline" class="mb-2">
                    Presets
                  </Button>
                {/snippet}
              </DropdownMenu.Trigger>
              <DropdownMenu.Content align="start">
                {#each PRESETS as p (p.label)}
                  <DropdownMenu.Item onSelect={() => applyPreset(p)}>{p.label}</DropdownMenu.Item>
                {/each}
              </DropdownMenu.Content>
            </DropdownMenu.Root>

            <div class="flex flex-wrap items-end gap-2">
              <Select.Root type="single" name="action" bind:value={action}>
                <Select.Trigger class="w-28">{action}</Select.Trigger>
                <Select.Content>
                  <Select.Item value="send">send</Select.Item>
                  <Select.Item value="deduct">deduct</Select.Item>
                </Select.Content>
              </Select.Root>

              <Input
                name="amount"
                type="number"
                min="1"
                bind:value={amount}
                placeholder="Amount"
                class="w-32"
                required
              />

              <Select.Root type="single" name="transactionType" bind:value={transactionType}>
                <Select.Trigger class="w-36">{transactionType}</Select.Trigger>
                <Select.Content>
                  {#each BUZZ_TRANSACTION_TYPES as t (t)}
                    <Select.Item value={t}>{t}</Select.Item>
                  {/each}
                </Select.Content>
              </Select.Root>

              <Select.Root type="single" name="buzzType" bind:value={buzzType}>
                <Select.Trigger class="w-28">{buzzType}</Select.Trigger>
                <Select.Content>
                  <Select.Item value="yellow">yellow</Select.Item>
                  <Select.Item value="blue">blue</Select.Item>
                  <Select.Item value="green">green</Select.Item>
                </Select.Content>
              </Select.Root>

              <Input
                name="description"
                bind:value={description}
                placeholder="Description"
                class="min-w-48 flex-1"
                required
              />

              <Button type="submit" size="sm" disabled={submitting}>
                {submitting ? 'Working…' : 'Apply'}
              </Button>
              <Button type="button" size="sm" variant="outline" onclick={() => (sending = false)}>
                Cancel
              </Button>
            </div>
          </form>
        {/if}
      {/if}
    </div>
  </div>
</section>
