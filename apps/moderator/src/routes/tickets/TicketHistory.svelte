<script lang="ts">
  import TriageCard from '$lib/components/triage/TriageCard.svelte';
  import { userLookupUrl } from '$lib/entity-url';
  import { dateTime, relativeTime } from '$lib/format';
  import { spaced } from '$lib/tickets/labels';
  import type {
    HistoryActivity,
    HistoryNote,
    HistoryRemoval,
    HistoryStrike,
    TicketHistory,
  } from '$lib/server/tickets/history';
  import TicketCardState from './TicketCardState.svelte';
  import TicketSection from './TicketSection.svelte';

  let { history }: { history: TicketHistory } = $props();
</script>

<TriageCard title="History" dense>
  {#if history.status !== 'ok'}
    <TicketCardState card={history} unlinked="history unavailable" unavailable="History unavailable." />
  {:else}
    <div class="flex flex-col gap-3">
      {#snippet strike(s: HistoryStrike)}
        <span class="text-white">{spaced(s.reason)}</span>
        · {s.status}{s.imported ? ' (imported)' : ''} · {s.points} pt
        · <span class="text-dark-2" title={dateTime(s.createdAt)}>{relativeTime(s.createdAt)}</span>
        {#if s.issuedByName}<span class="text-dark-2"> by {s.issuedByName}</span>{/if}
      {/snippet}
      <TicketSection
        title="Strikes"
        section={history.strikes}
        href={userLookupUrl(history.userId, 'notes')}
        empty="No strikes."
        row={strike}
        rowKey={(s) => s.id}
      />

      {#snippet note(n: HistoryNote)}
        <span class="whitespace-pre-wrap">{n.text || '(empty note)'}</span>
        <span class="text-dark-2">
          {#if n.by}— {n.by}{/if}{#if n.at}
            · <span title={dateTime(n.at)}>{relativeTime(n.at)}</span>{/if}
        </span>
      {/snippet}
      <TicketSection
        title="Notes"
        section={history.notes}
        href={userLookupUrl(history.userId, 'notes')}
        empty="No notes."
        row={note}
        rowKey={(n) => n.id}
      />

      {#snippet activity(a: HistoryActivity)}
        <span class="text-white">{spaced(a.activity)}</span>
        · {a.entityType}{a.entityId ? ` #${a.entityId}` : ''}
        · <span class="text-dark-2" title={dateTime(a.at)}>{relativeTime(a.at)}</span>
        {#if a.moderator}<span class="text-dark-2"> by {a.moderator}</span>{/if}
      {/snippet}
      <TicketSection
        title="Moderation activity"
        section={history.activity}
        href={userLookupUrl(history.userId, 'mod-activity')}
        empty="No recorded moderation activity."
        row={activity}
        rowKey={(a) => a.id}
      />

      {#snippet removal(r: HistoryRemoval)}
        <span class="text-white">{r.type === 'Restore' ? 'Restored' : r.type === 'DeleteTOS' ? 'Removed (ToS)' : 'Deleted'}</span>
        · image #{r.imageId}{r.reason ? ` · ${r.reason}` : ''}
        · <span class="text-dark-2" title={dateTime(r.at)}>{relativeTime(r.at)}</span>
        {#if r.actor}<span class="text-dark-2"> by {r.actor}</span>{/if}
      {/snippet}
      <TicketSection
        title="Image removals"
        section={history.removals}
        href={userLookupUrl(history.userId, 'mod-activity')}
        empty="No image removals."
        row={removal}
        rowKey={(r) => r.key}
      />
    </div>
  {/if}
</TriageCard>
