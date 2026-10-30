<script lang="ts">
  import { enhance } from '$app/forms';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import { Label } from '@civitai/ui/components/ui/label/index.js';
  import * as DropdownMenu from '@civitai/ui/components/ui/dropdown-menu/index.js';
  import * as Select from '@civitai/ui/components/ui/select/index.js';
  import { cn } from '@civitai/ui/utils.js';
  import { FormState } from '$lib/form-state.svelte';
  import {
    BUZZ_ACTIONS,
    BUZZ_COLORS,
    BUZZ_DEDUCT_REASONS,
    BUZZ_ENTITY_TYPES,
    BUZZ_SEND_REASONS,
  } from './enforcement-options';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';

  let { userId, onSuccess }: { userId: number; onSuccess: () => void } = $props();

  // Retool's BuzzTransferPopulate dropdown — canned amount, colour and reason per label. These exist
  // in no query; they were widget config, and moderators use them daily.
  const PRESETS = [
    {
      label: 'Stripe Chargeback Retrieval',
      amount: '',
      color: 'yellow',
      action: 'deduct',
      reason: 'ChargeBack',
    },
    { label: 'Stripe Refund', amount: '', color: 'yellow', action: 'deduct', reason: 'Refund' },
    {
      label: '1st Place Stream Bingo',
      amount: '5000',
      color: 'yellow',
      action: 'send',
      reason: 'Reward',
    },
    {
      label: '2nd Place Stream Bingo',
      amount: '2500',
      color: 'yellow',
      action: 'send',
      reason: 'Reward',
    },
    {
      label: '3rd Place Stream Bingo',
      amount: '1000',
      color: 'yellow',
      action: 'send',
      reason: 'Reward',
    },
  ];

  let action = $state('send');
  let reason = $state('');
  let color = $state('yellow');
  let amount = $state('');
  let description = $state('');
  let entityType = $state('');
  let entityId = $state('');

  const actionLabel = $derived(BUZZ_ACTIONS.find(([v]) => v === action)?.[1] ?? action);
  const colorLabel = $derived(BUZZ_COLORS.find(([v]) => v === color)?.[1] ?? color);

  const applyPreset = (p: (typeof PRESETS)[number]) => {
    amount = p.amount;
    description = p.label;
    color = p.color;
    action = p.action;
    reason = p.reason;
  };

  // Scoped by action, as Retool's SendTypes/DeductTypes were: `deduct + Reward` is not a transaction
  // anyone means to file. Changing the action invalidates a reason from the other list.
  const reasons = $derived(action === 'send' ? BUZZ_SEND_REASONS : BUZZ_DEDUCT_REASONS);
  const setAction = (next: string) => {
    action = next;
    if (!(reasons as readonly string[]).includes(reason)) reason = '';
  };

  type Filed = { action: string; amount: number; buzzType: string; transactionType: string };

  // What the server filed, not what the form asked for. The operator's only other evidence that a
  // write landed is noticing a balance change in another panel.
  let filed = $state<string | null>(null);
  const describe = (f: Filed | undefined) =>
    !f
      ? 'Transaction filed.'
      : `${f.action === 'deduct' ? 'Deducted' : 'Sent'} ${f.amount.toLocaleString()} ${
          BUZZ_COLORS.find(([v]) => v === f.buzzType)?.[1] ?? f.buzzType
        } — ${f.transactionType}`;

  // The transaction clears; the MODE does not. Amount, description and entityId belong to this one
  // adjustment — a kept amount is a double grant one stray click away, and a kept entityId attaches
  // the next adjustment to the previous grant's entity. Action, reason and colour are the batch being
  // worked, and neither files anything on its own while amount and description are required.
  //
  // `reset: false` because `update()`'s reset restores each input's `defaultValue`, which Svelte
  // never writes — it would blank the kept fields on screen while their state still held the old
  // value, and the next submit would post that stale value back. No `reload`: this panel's data comes
  // from `/api/*`, so re-running the page load would re-run the reaction scan behind every write.
  const buzz = new FormState({
    reset: false,
    onSubmit: () => (filed = null),
    onSuccess: (data) => {
      amount = '';
      description = '';
      entityType = '';
      entityId = '';
      filed = describe(data?.filed as Filed | undefined);
      onSuccess();
    },
  });

  const deducting = $derived(action === 'deduct');
</script>

<!-- One column, so the caller can stand this beside the balances and history rather than above them:
     a grant or deduction is judged against those numbers. Presets and the Deduct Types reference stay
     within a screen of the Reason picker — which types lower the lifetime balance and which may go
     negative is the fact needed WHILE choosing one. -->
<div class="space-y-4">
  <!-- Tinted by direction. The action picker and the submit label already name it, but both are one
       line in a column of identical controls, and the mode now SURVIVES a submit — so the panel itself
       carries which way the money is about to move. Only `deduct` is marked: a green or amber wash for
       `send` would compete with the confirmation below it and with the Buzz colours in the form. -->
  <section
    class={cn(
      'rounded-xl border p-5 transition-colors',
      deducting ? 'border-red-500/40 bg-red-500/5' : 'border-dark-4 bg-dark-6'
    )}
  >
    {#if buzz.error}
      <ErrorAlert class="mb-3" message={buzz.error} />
    {/if}

    {#if filed}
      <div
        class="mb-3 rounded-md border border-green-500/30 bg-green-500/10 p-2 text-sm text-green-200"
        role="status"
      >
        {filed}
      </div>
    {/if}

    <form method="POST" action="?/sendBuzz" use:enhance={buzz.enhance} class="space-y-3">
      <input type="hidden" name="userId" value={userId} />

      <div>
        <Label for="buzz-action">Action</Label>
        <Select.Root type="single" name="action" value={action} onValueChange={setAction}>
          <Select.Trigger id="buzz-action" class="mt-1 w-full">{actionLabel}</Select.Trigger>
          <Select.Content>
            {#each BUZZ_ACTIONS as [value, label] (value)}
              <Select.Item {value}>{label}</Select.Item>
            {/each}
          </Select.Content>
        </Select.Root>
      </div>

      <div>
        <Label for="buzz-reason">Reason</Label>
        <Select.Root type="single" name="transactionType" bind:value={reason}>
          <Select.Trigger id="buzz-reason" class="mt-1 w-full">
            {reason || 'Select an option'}
          </Select.Trigger>
          <Select.Content>
            {#each reasons as t (t)}
              <Select.Item value={t}>{t}</Select.Item>
            {/each}
          </Select.Content>
        </Select.Root>
      </div>

      <div>
        <Label for="buzz-color">Type of Buzz</Label>
        <Select.Root type="single" name="buzzType" bind:value={color}>
          <Select.Trigger id="buzz-color" class="mt-1 w-full">{colorLabel}</Select.Trigger>
          <Select.Content>
            {#each BUZZ_COLORS as [value, label] (value)}
              <Select.Item {value}>{label}</Select.Item>
            {/each}
          </Select.Content>
        </Select.Root>
      </div>

      <div>
        <Label for="buzz-amount">Amount</Label>
        <Input
          id="buzz-amount"
          name="amount"
          type="number"
          min="1"
          bind:value={amount}
          class="mt-1"
          required
        />
      </div>

      <div>
        <Label for="buzz-description">Description</Label>
        <Input
          id="buzz-description"
          name="description"
          bind:value={description}
          class="mt-1"
          required
        />
      </div>

      <!-- What the grant or deduction is ABOUT. Optional: most adjustments are not tied to an entity. -->
      <div class="flex gap-3">
        <div class="flex-1">
          <Label for="buzz-entity-type">EntityType</Label>
          <Select.Root type="single" name="entityType" bind:value={entityType}>
            <Select.Trigger id="buzz-entity-type" class="mt-1 w-full">
              {entityType || 'Optional'}
            </Select.Trigger>
            <Select.Content>
              {#each BUZZ_ENTITY_TYPES as t (t)}
                <Select.Item value={t}>{t}</Select.Item>
              {/each}
            </Select.Content>
          </Select.Root>
        </div>
        <div class="w-32">
          <Label for="buzz-entity-id">EntityId</Label>
          <Input id="buzz-entity-id" name="entityId" type="number" min="1" bind:value={entityId} class="mt-1" />
        </div>
      </div>

      <Button
        type="submit"
        variant={deducting ? 'destructive' : 'default'}
        class="w-full"
        disabled={buzz.submitting || !reason}
      >
        {buzz.submitting ? 'Working…' : deducting ? 'Deduct Buzz' : 'Send Buzz'}
      </Button>
    </form>
  </section>

  <section class="rounded-xl border border-dark-4 bg-dark-6 p-5">
    <h4 class="mb-3 text-sm font-semibold text-white">Presets</h4>
    <DropdownMenu.Root>
      <DropdownMenu.Trigger>
        {#snippet child({ props })}
          <Button {...props} type="button" class="w-full">Apply a preset</Button>
        {/snippet}
      </DropdownMenu.Trigger>
      <DropdownMenu.Content align="start">
        {#each PRESETS as p (p.label)}
          <DropdownMenu.Item onSelect={() => applyPreset(p)}>{p.label}</DropdownMenu.Item>
        {/each}
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  </section>

  <section class="rounded-xl border border-dark-4 bg-dark-6 p-5">
    <h4 class="mb-3 text-sm font-semibold text-white">Deduct Types</h4>
    <table class="w-full text-xs text-dark-2">
      <thead>
        <tr class="text-left text-dark-0">
          <th class="py-1 pr-3 font-medium">Type</th>
          <th class="py-1 pr-3 font-medium">Lowers lifetime</th>
          <th class="py-1 font-medium">Can go negative</th>
        </tr>
      </thead>
      <tbody>
        {#each [['Purchase', false, false], ['AuthorizedPurchase', false, true], ['Chargeback', true, true]] as [name, lifetime, negative] (name)}
          <tr class="border-t border-dark-4">
            <td class="py-1 pr-3">{name}</td>
            <td class="py-1 pr-3">{lifetime ? '✓' : '—'}</td>
            <td class="py-1">{negative ? '✓' : '—'}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </section>
</div>
