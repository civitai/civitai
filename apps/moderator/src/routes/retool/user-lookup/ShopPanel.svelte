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

  let {
    account,
    userId,
    canAct,
    canGrantCosmetics,
    onSuccess,
  }: {
    account: Promise<Account> | null;
    userId: number;
    canAct: boolean;
    canGrantCosmetics: boolean;
    onSuccess: () => void;
  } = $props();

  // Called through, not captured: reading the prop inside the closure is what stops a re-passed
  // callback being ignored (svelte’s `state_referenced_locally`).
  const form = new FormState({ onSuccess: () => onSuccess() });
  let grantId = $state('');
</script>

{#if form.error}
  <ErrorAlert class="mb-4" message={form.error} />
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
        hint="Refunding flags the purchase and removes the cosmetic. The Buzz is not returned automatically — use the Buzz section."
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
  {/if}
{:catch}
  <div class="rounded-xl border border-dark-4 bg-dark-6 p-5">
    <p class="text-sm text-red-300">Could not load shop purchases.</p>
  </div>
{/await}
