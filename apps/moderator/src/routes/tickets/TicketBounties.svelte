<script lang="ts">
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import TriageCard from '$lib/components/triage/TriageCard.svelte';
  import { userLookupUrl } from '$lib/entity-url';
  import { LINK_CLASS, dateTime, num, relativeTime } from '$lib/format';
  import { bountyTypeLabel } from '$lib/tickets/labels';
  import type { BountyEntryRow, BountyRow, TicketBounties } from '$lib/server/tickets/bounties';
  import TicketCardState from './TicketCardState.svelte';
  import TicketSection from './TicketSection.svelte';

  let { bounties: card }: { bounties: TicketBounties } = $props();
</script>

{#snippet funded(b: BountyRow)}
  <span class="text-white">{b.name}</span>
  <Badge variant={b.complete ? 'secondary' : 'outline'}>{b.complete ? 'Complete' : 'Open'}</Badge>
  · {bountyTypeLabel(b.type)} · {num(b.pledged)} Buzz
  · <span class="text-dark-2" title={dateTime(b.createdAt)}>{relativeTime(b.createdAt)}</span>
  <span class="text-dark-2"> · ends {dateTime(b.expiresAt)}</span>
{/snippet}

{#snippet entered(e: BountyEntryRow)}
  <span class="text-white">{e.bountyName}</span>
  · entry #{e.id}
  · <span class="text-dark-2" title={dateTime(e.createdAt)}>{relativeTime(e.createdAt)}</span>
{/snippet}

<TriageCard title="Bounties" dense>
  {#if card.status !== 'ok'}
    <TicketCardState
      {card}
      unlinked="bounties unavailable"
      unavailable="Bounties unavailable."
      lookup="bounties"
    />
  {:else}
    <div class="flex flex-col gap-3">
      <div class="flex justify-end">
        <a class={LINK_CLASS} href={userLookupUrl(card.userId, 'bounties')}>User Lookup</a>
      </div>
      <TicketSection
        title="Bounties funded"
        section={card.bounties}
        empty="No bounties."
        row={funded}
        rowKey={(b) => b.id}
      />
      <TicketSection
        title="Entries submitted"
        section={card.entries}
        empty="No entries."
        row={entered}
        rowKey={(e) => e.id}
      />
    </div>
  {/if}
</TriageCard>
