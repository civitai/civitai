<script lang="ts">
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import TriageCard from '$lib/components/triage/TriageCard.svelte';
  import { userLookupUrl } from '$lib/entity-url';
  import { LINK_CLASS, dateTime } from '$lib/format';
  import { subscriptionBadge } from '$lib/tickets/labels';
  import type { TicketMembership } from '$lib/server/tickets/membership';

  let { membership }: { membership: TicketMembership } = $props();
</script>

<TriageCard title="Membership" dense>
  {#if membership.status === 'unlinked'}
    <p class="m-0 text-dark-2">No linked Civitai account — membership unavailable</p>
  {:else if membership.status === 'unavailable'}
    <p class="m-0 text-amber-300">
      Membership unavailable.
      <a class={LINK_CLASS} href={userLookupUrl(membership.userId, 'basic')}>User #{membership.userId}</a>
    </p>
  {:else}
    {@const { subscription: s, userId } = membership}
    <div class="flex flex-col gap-1">
      <div class="flex items-baseline justify-between gap-2">
        <span class="font-medium text-white">Subscription</span>
        <a class={LINK_CLASS} href={userLookupUrl(userId, 'basic')}>User Lookup</a>
      </div>
      {#if !s}
        <p class="m-0 text-dark-2">No subscription on record.</p>
      {:else}
        <div class="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span class="text-white">{s.productName ?? 'Unknown plan'}</span>
          {#if s.buzzType === 'buzzPurchase'}
            <Badge variant="outline">Buzz-bought</Badge>
          {:else if s.buzzType === 'referral'}
            <Badge variant="outline">Referral grant</Badge>
          {/if}
          {#if s.interval}<Badge variant="outline">{s.interval}ly</Badge>{/if}
          <Badge variant={subscriptionBadge(s.status)}>{s.status}</Badge>
          {#if s.provider}<span class="text-dark-2">via {s.provider}</span>{/if}
        </div>
        <div class="text-dark-2">
          {#if s.unitAmount != null}
            Price: {(s.unitAmount / 100).toFixed(2)} {(s.currency ?? '').toUpperCase()}{#if s.interval} / {s.interval}{/if}
            ·
          {/if}
          Renews / ends: {dateTime(s.currentPeriodEnd)}
        </div>
        {#if s.cancelAtPeriodEnd}<div class="text-amber-300">Set to cancel at period end</div>{/if}
      {/if}
    </div>
  {/if}
</TriageCard>
