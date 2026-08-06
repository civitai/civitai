<script lang="ts">
  import { browser } from '$app/environment';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import type { PageData } from './$types';
  import { dateTime, num } from './format';

  type Subscription = NonNullable<PageData['result']>['subscription'];

  export type Account = {
    buzz: { balance: number; lifetimeBalance: number } | null;
    reviews: unknown[];
    comments: unknown[];
    cosmetics: unknown[];
  };

  let { subscription, userId }: { subscription: Subscription; userId: number } = $props();

  // Buzz is an external service; the balance arrives after the subscription, which is already in the load.
  const account = $derived(
    browser
      ? fetch(`/api/user-account/${userId}`).then((r): Promise<Account> => {
          if (!r.ok) throw new Error(String(r.status));
          return r.json();
        })
      : null
  );
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
        <dl class="mt-2 space-y-0.5 text-sm text-dark-1">
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
        {#if !result?.buzz}
          <p class="text-sm text-dark-2">Balance unavailable.</p>
        {:else}
          <div class="flex gap-6">
            <div>
              <div class="text-xl font-semibold tabular-nums text-white">
                {num(result.buzz.balance)}
              </div>
              <div class="text-xs text-dark-2">Balance</div>
            </div>
            <div>
              <div class="text-xl font-semibold tabular-nums text-white">
                {num(result.buzz.lifetimeBalance)}
              </div>
              <div class="text-xs text-dark-2">Lifetime</div>
            </div>
          </div>
        {/if}
      {:catch}
        <p class="text-sm text-red-300">Could not load Buzz balance.</p>
      {/await}
    </div>
  </div>
</section>
