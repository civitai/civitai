<script lang="ts">
  import { FormState } from '$lib/form-state.svelte';
  import { enhance } from '$app/forms';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import * as Select from '@civitai/ui/components/ui/select/index.js';
  import { dateTime, num } from '$lib/format';
  import type { Account } from './user-account';
  import ListCard from './ListCard.svelte';
  import { denied } from '$lib/permissions';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';
  import WarningAlert from '$lib/components/WarningAlert.svelte';
  import ConfirmButton from '$lib/components/ConfirmButton.svelte';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import { MAX_BOXES_PER_USER, newBoxGrantId } from '$lib/mystery-box';

  let {
    account,
    userId,
    canAct,
    canGrantCosmetics,
    canGrantBoxes,
    onSuccess,
  }: {
    account: Promise<Account> | null;
    userId: number;
    canAct: boolean;
    canGrantCosmetics: boolean;
    canGrantBoxes: boolean;
    onSuccess: () => void;
  } = $props();

  // Called through, not captured: reading the prop inside the closure is what stops a re-passed
  // callback being ignored (svelte’s `state_referenced_locally`).
  const form = new FormState({ onSuccess: () => onSuccess() });
  let grantId = $state('');

  // A new id once a grant lands, so the next one is a new grant rather than a repeat of this one.
  // `reset: false`: a reset would empty the box picker's hidden input under a still-shown choice.
  const boxForm = new FormState({
    onSuccess: () => {
      boxGrantId = newBoxGrantId();
      boxId = '';
      onSuccess();
    },
    reset: false,
  });
  let boxGrantId = $state(newBoxGrantId());
  let boxId = $state('');

  const STATE_LABEL = { held: 'unopened', opened: 'opened', takenBack: 'taken back' } as const;
</script>

{#if form.error}
  <ErrorAlert class="mb-4" message={form.error} />
{/if}
{#if form.warning}
  <WarningAlert class="mb-4" message={form.warning} />
{/if}

{#await account}
  <div class="rounded-xl border border-dark-4 bg-dark-6 p-5">
    <p class="text-sm text-dark-2">Loading shop purchases…</p>
  </div>
{:then result}
  {#if result}
    <section class="mb-4 grid gap-4 lg:grid-cols-2">
      <ListCard
        title="Shop purchases"
        total={result.shopPurchases.items.length} capped={result.shopPurchases.truncated}
        shown={10}
        hint="Refunding flags the purchase and takes back what it granted: the cosmetic, a pack's cosmetics, or the box (its reward, once opened). The Buzz is not returned automatically — use the Buzz section."
      >
        {#snippet children(limit)}
          <ul class="space-y-1 text-sm">
            {#each result.shopPurchases.items.slice(0, limit) as p (p.buzzTransactionId)}
              <li class="flex flex-wrap items-baseline gap-x-2">
                <span class="text-dark-0">{p.title}</span>
                <span class="tabular-nums text-dark-2">{num(p.unitAmount)} buzz</span>
                <span class="text-xs text-dark-2">{dateTime(p.purchasedAt)}</span>
                {#if p.refunded}
                  <Badge variant="secondary">refunded</Badge>
                {:else if canAct}
                  <form method="POST" action="?/refundPurchase" use:enhance={form.enhance}>
                    <input type="hidden" name="userId" value={userId} />
                    <input
                      type="hidden"
                      name="buzzTransactionId"
                      value={p.buzzTransactionId}
                    />
                    <Button type="submit" size="xs" variant="destructive" disabled={form.submitting}>
                      Refund
                    </Button>
                  </form>
                {/if}
              </li>
            {/each}
          </ul>
        {/snippet}
      </ListCard>

      <div class="rounded-xl border border-dark-4 bg-dark-6 p-5">
        <h3 class="mb-1 text-sm font-semibold text-white">Grant a badge</h3>
        <p class="mb-3 text-xs text-dark-2">
          Badges this account does not already hold ({result.availableBadges.length}).
        </p>
        {#if !canGrantCosmetics}
          <p class="text-sm text-dark-2">{denied('user.cosmetics.grant')}</p>
        {:else if result.availableBadges.length === 0}
          <p class="text-sm text-dark-2">This account already holds every badge.</p>
        {:else}
          <form method="POST" action="?/grantCosmetic" use:enhance={form.enhance}>
            <input type="hidden" name="userId" value={userId} />
            <div class="flex flex-wrap items-end gap-2">
              <Select.Root type="single" name="cosmeticId" bind:value={grantId}>
                <Select.Trigger class="min-w-56 flex-1">
                  {result.availableBadges.find((b) => String(b.id) === grantId)?.name ??
                    'Choose a badge'}
                </Select.Trigger>
                <Select.Content>
                  {#each result.availableBadges as b (b.id)}
                    <Select.Item value={String(b.id)}>{b.name}</Select.Item>
                  {/each}
                </Select.Content>
              </Select.Root>
              <Button type="submit" size="sm" disabled={!grantId || form.submitting}>Grant</Button>
            </div>
          </form>
        {/if}
      </div>
    </section>

    <section class="mb-4 rounded-xl border border-dark-4 bg-dark-6 p-5">
      <h3 class="mb-1 text-sm font-semibold text-white">Mystery boxes</h3>
      <p class="mb-3 text-xs text-dark-2">
        A granted box is free: no purchase, no Buzz. Taking one back removes the box, or what it gave
        once opened.
      </p>
      {#if boxForm.error}
        <ErrorAlert class="mb-3" message={boxForm.error} />
      {/if}
      {#if boxForm.warning}
        <WarningAlert class="mb-3" message={boxForm.warning} />
      {/if}
      {#if !canGrantBoxes}
        <p class="text-sm text-dark-2">{denied('items.boxes.grant')}</p>
      {:else if result.grantableBoxes.length === 0}
        <p class="text-sm text-dark-2">No box is published.</p>
      {:else}
        <form method="POST" action="?/grantBox" use:enhance={boxForm.enhance} class="mb-4">
          <input type="hidden" name="userId" value={userId} />
          <input type="hidden" name="grantId" value={boxGrantId} />
          <div class="flex flex-wrap items-end gap-2">
            <Select.Root type="single" name="boxId" bind:value={boxId}>
              <Select.Trigger class="min-w-56 flex-1">
                {result.grantableBoxes.find((b) => String(b.id) === boxId)?.name ?? 'Choose a box'}
              </Select.Trigger>
              <Select.Content>
                {#each result.grantableBoxes as b (b.id)}
                  <Select.Item value={String(b.id)}>#{b.id} {b.name}</Select.Item>
                {/each}
              </Select.Content>
            </Select.Root>
            <Input
              type="number"
              name="count"
              min={1}
              max={MAX_BOXES_PER_USER}
              value={1}
              class="h-8 w-20"
              aria-label="How many boxes"
            />
            <Button type="submit" size="sm" disabled={!boxId || boxForm.submitting}>Grant</Button>
          </div>
        </form>
      {/if}

      {#if result.grantedBoxes.items.length}
        <ul class="space-y-1 text-sm">
          {#each result.grantedBoxes.items as box (box.sourceKey)}
            <li class="flex flex-wrap items-baseline gap-x-2">
              <span class="text-dark-0">{box.boxName}</span>
              <Badge variant="secondary">{STATE_LABEL[box.state]}</Badge>
              {#if box.reward}
                <span class="text-xs text-dark-2">gave {box.reward}</span>
              {/if}
              <span class="text-xs text-dark-2">{dateTime(box.at)}</span>
              {#if canGrantBoxes && box.state !== 'takenBack'}
                <form method="POST" action="?/takeBackGrantedBox" use:enhance={boxForm.enhance}>
                  <input type="hidden" name="userId" value={userId} />
                  <input type="hidden" name="sourceKey" value={box.sourceKey} />
                  <ConfirmButton
                    label="Take back"
                    title="Take back this box?"
                    description={box.state === 'held'
                      ? 'The unopened box is removed from this account.'
                      : `The ${box.reward ?? 'reward'} it gave is removed from this account. The opening stays on record.`}
                    disabled={boxForm.submitting}
                  />
                </form>
              {/if}
            </li>
          {/each}
        </ul>
        {#if result.grantedBoxes.truncated}
          <p class="mt-2 text-xs text-dark-2">Showing the latest {result.grantedBoxes.items.length}.</p>
        {/if}
      {:else}
        <p class="text-sm text-dark-2">No boxes granted to this account.</p>
      {/if}
    </section>
  {/if}
{:catch}
  <div class="rounded-xl border border-dark-4 bg-dark-6 p-5">
    <p class="text-sm text-red-300">Could not load shop purchases.</p>
  </div>
{/await}
