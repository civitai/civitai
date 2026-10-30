<script lang="ts">
  import TriageCard from '$lib/components/triage/TriageCard.svelte';
  import { userLookupUrl } from '$lib/entity-url';
  import { dateTime, num, relativeTime } from '$lib/format';
  import type { ShopPurchaseRow, TicketShop } from '$lib/server/tickets/shop-purchases';
  import TicketCardState from './TicketCardState.svelte';
  import TicketSection from './TicketSection.svelte';

  let { shop: card }: { shop: TicketShop } = $props();
</script>

{#snippet purchase(p: ShopPurchaseRow)}
  <span class="text-white">{p.title}</span>
  · {num(p.amount)} Buzz
  · <span class="text-dark-2" title={dateTime(p.at)}>{relativeTime(p.at)}</span>
  {#if p.refunded}<span class="text-amber-300"> · refunded</span>{/if}
{/snippet}

<TriageCard title="Cosmetic shop" dense>
  {#if card.status !== 'ok'}
    <TicketCardState
      {card}
      unlinked="purchases unavailable"
      unavailable="Purchases unavailable."
      lookup="shop"
    />
  {:else}
    <TicketSection
      title="Recent purchases"
      section={{ status: 'ok', rows: card.purchases, truncated: card.truncated }}
      href={userLookupUrl(card.userId, 'shop')}
      empty="No purchases."
      row={purchase}
      rowKey={(p) => p.id}
    />
  {/if}
</TriageCard>
