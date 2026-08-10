<script lang="ts">
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import type { LayoutData } from './$types';
  import { dateTime } from '$lib/format';

  type Subscription = NonNullable<LayoutData['result']>['subscription'];

  let { subscription }: { subscription: Subscription } = $props();
</script>

<section class="mb-4 rounded-xl border border-dark-4 bg-dark-6 p-5">
  <h3 class="mb-3 text-sm font-semibold text-white">Subscription</h3>

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
</section>
