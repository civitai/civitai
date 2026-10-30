<script lang="ts">
  import TriageCard from '$lib/components/triage/TriageCard.svelte';
  import { userLookupUrl } from '$lib/entity-url';
  import { LINK_CLASS, dateTime, num, relativeTime } from '$lib/format';
  import type { TicketShop } from '$lib/server/tickets/shop-purchases';

  let { shop }: { shop: TicketShop } = $props();
</script>

<TriageCard title="Cosmetic shop" dense>
  {#if shop.status === 'unlinked'}
    <p class="m-0 text-dark-2">No linked Civitai account — purchases unavailable</p>
  {:else if shop.status === 'unavailable'}
    <p class="m-0 text-amber-300">
      Purchases unavailable.
      <a class={LINK_CLASS} href={userLookupUrl(shop.userId, 'shop')}>User #{shop.userId}</a>
    </p>
  {:else}
    {@const { purchases, truncated, userId } = shop}
    <div class="flex flex-col gap-1">
      <div class="flex items-baseline justify-between gap-2">
        <span class="font-medium text-white">Recent purchases</span>
        <a class={LINK_CLASS} href={userLookupUrl(userId, 'shop')}>{truncated ? 'All in User Lookup' : 'User Lookup'}</a>
      </div>
      {#if purchases.length === 0}
        <p class="m-0 text-dark-2">No purchases.</p>
      {:else}
        <ul class="m-0 flex list-none flex-col gap-1 p-0">
          {#each purchases as p (p.id)}
            <li class="min-w-0 break-words">
              <span class="text-white">{p.title}</span>
              · {num(p.amount)} Buzz
              · <span class="text-dark-2" title={dateTime(p.at)}>{relativeTime(p.at)}</span>
              {#if p.refunded}<span class="text-amber-300"> · refunded</span>{/if}
            </li>
          {/each}
        </ul>
        {#if truncated}<p class="m-0 text-dark-2">Showing the newest {purchases.length}.</p>{/if}
      {/if}
    </div>
  {/if}
</TriageCard>
