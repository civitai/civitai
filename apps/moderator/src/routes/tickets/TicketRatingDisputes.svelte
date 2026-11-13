<script lang="ts">
  import { page } from '$app/state';
  import { ratingReviewEntityLabels, ratingReviewLevelLabel } from '@civitai/shared/rating-review';
  import TriageCard from '$lib/components/triage/TriageCard.svelte';
  import { userLookupUrl } from '$lib/entity-url';
  import { LINK_CLASS, dateTime, relativeTime } from '$lib/format';
  import { ratingReviewStatusBadge } from '$lib/rating-review';
  import type { TicketRatingDisputes } from '$lib/server/tickets/rating-disputes';
  import TicketRatingRuling from './TicketRatingRuling.svelte';

  let {
    ticketId,
    disputes,
    ondone,
  }: {
    ticketId: string;
    disputes: TicketRatingDisputes;
    ondone: (what: string, data: Record<string, unknown> | undefined) => void;
  } = $props();
</script>

<TriageCard title="Rating disputes" dense>
  {#if disputes.status === 'unlinked'}
    <p class="m-0 text-dark-2">No linked Civitai account — rating disputes unavailable</p>
  {:else if disputes.status === 'unavailable'}
    <p class="m-0 text-amber-300">
      Rating disputes unavailable.
      <a class={LINK_CLASS} href={userLookupUrl(disputes.userId, 'basic')}>User #{disputes.userId}</a>
    </p>
  {:else if disputes.disputes.length === 0}
    <p class="m-0 text-dark-2">No rating disputes.</p>
  {:else}
    <ul class="m-0 flex list-none flex-col gap-2 p-0">
      {#each disputes.disputes as d (d.id)}
        {@const badge = ratingReviewStatusBadge[d.status]}
        <li class="flex flex-col gap-0.5">
          <div class="text-white">
            {#if d.path}
              <a class={LINK_CLASS} href={page.data.civitaiUrl + d.path}>
                {d.title ?? `${ratingReviewEntityLabels[d.entityType]} #${d.entityId}`}
              </a>
            {:else}
              {d.title ?? `${ratingReviewEntityLabels[d.entityType]} #${d.entityId}`}{d.entityExists ? '' : ' (deleted)'}
            {/if}
            · <span class={d.status === 'Pending' ? 'text-amber-300' : ''}>{badge?.label ?? d.status}</span>
          </div>
          <div class="text-dark-2">
            {ratingReviewLevelLabel(d.entityType, d.currentLevel)} → asks
            {ratingReviewLevelLabel(d.entityType, d.suggestedLevel)}
            {#if d.appliedLevel !== null}· applied {ratingReviewLevelLabel(d.entityType, d.appliedLevel)}{/if}
            · filed <span title={d.createdAt ? dateTime(d.createdAt) : ''}>{d.createdAt ? relativeTime(d.createdAt) : '—'}</span>
            {#if d.resolvedAt}· decided <span title={dateTime(d.resolvedAt)}>{relativeTime(d.resolvedAt)}</span>{/if}
          </div>
          {#if d.userComment}<div class="min-w-0 break-words text-dark-2">“{d.userComment}”</div>{/if}
          {#if d.modComment}<div class="min-w-0 break-words text-dark-2">Moderator note: “{d.modComment}”</div>{/if}
          {#if d.rulable}
            <TicketRatingRuling {ticketId} userId={disputes.userId} dispute={d} {ondone} />
          {/if}
        </li>
      {/each}
    </ul>
    {#if disputes.truncated}
      <p class="m-0 mt-2 text-dark-2">Showing {disputes.disputes.length}: pending first, then newest.</p>
    {/if}
  {/if}
</TriageCard>
