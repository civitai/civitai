<script lang="ts">
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import TriageCard from '$lib/components/triage/TriageCard.svelte';
  import { userLookupUrl } from '$lib/entity-url';
  import { LINK_CLASS, dateTime, num, relativeTime } from '$lib/format';
  import type { PayoutRow, TicketPayouts } from '$lib/server/tickets/payouts';

  let { payouts: payoutsData }: { payouts: TicketPayouts } = $props();

  // Buzz requests are in Buzz, cash ones in cents.
  const amount = (p: PayoutRow, n: number) =>
    p.kind === 'cash' ? `$${(n / 100).toFixed(2)}` : `${num(n)} Buzz`;
</script>

<TriageCard title="Payouts" dense>
  {#if payoutsData.status === 'unlinked'}
    <p class="m-0 text-dark-2">No linked Civitai account — payouts unavailable</p>
  {:else if payoutsData.status === 'unavailable'}
    <p class="m-0 text-amber-300">
      Payouts unavailable.
      <a class={LINK_CLASS} href={userLookupUrl(payoutsData.userId, 'buzz')}>User #{payoutsData.userId}</a>
    </p>
  {:else}
    {@const { payouts, truncated, userId } = payoutsData}
    <div class="flex flex-col gap-1">
      <div class="flex items-baseline justify-between gap-2">
        <span class="font-medium text-white">Withdrawals</span>
        <a class={LINK_CLASS} href={userLookupUrl(userId, 'buzz')}>{truncated ? 'All in User Lookup' : 'User Lookup'}</a>
      </div>
      {#if payouts.length === 0}
        <p class="m-0 text-dark-2">No payouts.</p>
      {:else}
        <ul class="m-0 flex list-none flex-col gap-1 p-0">
          {#each payouts as p (p.id)}
            <li class="min-w-0 break-words">
              <Badge variant="outline">{p.status}</Badge>
              <span class="text-white">{amount(p, p.requested)}</span> requested
              {#if p.transferred !== null}· {amount(p, p.transferred)} transferred{/if}
              {#if p.provider}<span class="text-dark-2"> via {p.provider}</span>{/if}
              {#if p.at}· <span class="text-dark-2" title={dateTime(p.at)}>{relativeTime(p.at)}</span>{/if}
            </li>
          {/each}
        </ul>
        {#if truncated}<p class="m-0 text-dark-2">Showing the newest {payouts.length}.</p>{/if}
      {/if}
    </div>
  {/if}
</TriageCard>
