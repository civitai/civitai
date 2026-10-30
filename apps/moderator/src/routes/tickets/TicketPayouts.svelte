<script lang="ts">
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import TriageCard from '$lib/components/triage/TriageCard.svelte';
  import { userLookupUrl } from '$lib/entity-url';
  import { dateTime, num, relativeTime } from '$lib/format';
  import { payoutStatusLabel } from '$lib/tickets/labels';
  import type { PayoutRow, TicketPayouts } from '$lib/server/tickets/payouts';
  import TicketCardState from './TicketCardState.svelte';
  import TicketSection from './TicketSection.svelte';

  let { payouts: card }: { payouts: TicketPayouts } = $props();

  // Buzz requests are in Buzz, cash ones in cents.
  const amount = (p: PayoutRow, n: number) =>
    p.kind === 'cash' ? `$${(n / 100).toFixed(2)}` : `${num(n)} Buzz`;
</script>

{#snippet payout(p: PayoutRow)}
  <Badge variant="outline">{payoutStatusLabel(p.status)}</Badge>
  <span class="text-white">{amount(p, p.requested)}</span> requested
  {#if p.transferred !== null}· {amount(p, p.transferred)} transferred{/if}
  {#if p.provider}<span class="text-dark-2"> via {p.provider}</span>{/if}
  {#if p.at}· <span class="text-dark-2" title={dateTime(p.at)}>{relativeTime(p.at)}</span>{/if}
{/snippet}

<TriageCard title="Payouts" dense>
  {#if card.status !== 'ok'}
    <TicketCardState
      {card}
      unlinked="payouts unavailable"
      unavailable="Payouts unavailable."
      lookup="buzz"
    />
  {:else}
    <TicketSection
      title="Withdrawals"
      section={{ status: 'ok', rows: card.payouts, truncated: card.truncated }}
      href={userLookupUrl(card.userId, 'buzz')}
      empty="No payouts."
      row={payout}
      rowKey={(p) => p.id}
    />
  {/if}
</TriageCard>
