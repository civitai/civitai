<script lang="ts">
  import { page } from '$app/state';
  import { resolutionReasonLabel } from '@civitai/shared/resolution-reasons';
  import TriageCard from '$lib/components/triage/TriageCard.svelte';
  import { entityUrl, imageLookupUrl, modelLookupUrl, userLookupUrl } from '$lib/entity-url';
  import { LINK_CLASS, dateTime, relativeTime } from '$lib/format';
  import type { TicketAppeal, TicketAppeals } from '$lib/server/tickets/appeals';
  import { APPEAL_KIND_LABEL, APPEAL_WINDOW_DAYS } from '$lib/tickets/appeals';
  import TicketAppealRuling from './TicketAppealRuling.svelte';

  let {
    ticketId,
    appeals,
    ondone,
  }: {
    ticketId: string;
    appeals: TicketAppeals;
    ondone: (what: string, data: Record<string, unknown> | undefined) => void;
  } = $props();

  function entityHref(a: TicketAppeal): string | null {
    if (a.entityType === 'Image') return imageLookupUrl(a.entityId);
    if (a.entityType === 'Model') return modelLookupUrl(a.entityId);
    return entityUrl(page.data.civitaiUrl, a.entityType, a.entityId);
  }
</script>

<TriageCard title="Appeals" dense>
  {#if appeals.status === 'unlinked'}
    <p class="m-0 text-dark-2">No linked Civitai account — appeals unavailable</p>
  {:else if appeals.status === 'unavailable'}
    <p class="m-0 text-amber-300">
      Appeals unavailable.
      <a class={LINK_CLASS} href={userLookupUrl(appeals.userId, 'basic')}>User #{appeals.userId}</a>
    </p>
  {:else if appeals.appeals.length === 0}
    <p class="m-0 text-dark-2">No pending appeals, and none in the last {APPEAL_WINDOW_DAYS} days.</p>
  {:else}
    <ul class="m-0 flex list-none flex-col gap-2 p-0">
      {#each appeals.appeals as a (a.id)}
        {@const href = entityHref(a)}
        <li class="flex flex-col gap-0.5">
          <div class="text-white">
            {APPEAL_KIND_LABEL[a.kind]} ·
            {#if href}<a class={LINK_CLASS} {href}>{a.entityType} #{a.entityId}</a>{:else}{a.entityType} #{a.entityId}{/if}
            · <span class={a.status === 'Pending' ? 'text-amber-300' : ''}>{a.status}</span>
            {#if a.mentioned}<span class="ml-1 rounded bg-dark-4 px-1 text-[11px]">mentioned in ticket</span>{/if}
          </div>
          <div class="text-dark-2">
            Filed <span title={dateTime(a.createdAt)}>{relativeTime(a.createdAt)}</span>
            {#if a.resolvedAt}
              · decided <span title={dateTime(a.resolvedAt)}>{relativeTime(a.resolvedAt)}</span>
            {/if}
          </div>
          {#if a.resolvedReason || a.resolvedMessage}
            <div class="min-w-0 break-words text-dark-2">
              {#if a.resolvedReason}{resolutionReasonLabel(a.resolvedReason)}{/if}{#if a.resolvedReason && a.resolvedMessage}
                ·
              {/if}{#if a.resolvedMessage}“{a.resolvedMessage}”{/if}
            </div>
          {/if}
          {#if a.rulable}
            <TicketAppealRuling {ticketId} userId={appeals.userId} appealId={a.id} {ondone} />
          {/if}
        </li>
      {/each}
    </ul>
    {#if appeals.truncated}
      <p class="m-0 mt-2 text-dark-2">Showing the newest {appeals.appeals.length}.</p>
    {/if}
  {/if}
</TriageCard>
