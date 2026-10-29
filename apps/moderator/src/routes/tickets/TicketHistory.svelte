<script lang="ts">
  import TriageCard from '$lib/components/triage/TriageCard.svelte';
  import { userLookupUrl } from '$lib/entity-url';
  import { LINK_CLASS, dateTime, relativeTime } from '$lib/format';
  import type { Snippet } from 'svelte';
  import type {
    HistoryActivity,
    HistoryNote,
    HistoryRemoval,
    HistorySection,
    HistoryStrike,
    TicketHistory,
  } from '$lib/server/tickets/history';

  let { history }: { history: TicketHistory } = $props();

  const spaced = (s: string) => s.replace(/([a-z])([A-Z])/g, '$1 $2');
</script>

{#snippet block<T>(
  title: string,
  section: HistorySection<T>,
  lookup: string,
  empty: string,
  row: Snippet<[T]>
)}
  {#if history.status === 'ok'}
    <div class="flex flex-col gap-1">
      <div class="flex items-baseline justify-between gap-2">
        <span class="font-medium text-white">{title}</span>
        <a class={LINK_CLASS} href={userLookupUrl(history.userId, lookup)}>
          {section.status === 'ok' && section.truncated ? 'All in User Lookup' : 'User Lookup'}
        </a>
      </div>
      {#if section.status === 'unavailable'}
        <p class="m-0 text-amber-300">Unavailable.</p>
      {:else if section.rows.length === 0}
        <p class="m-0 text-dark-2">{empty}</p>
      {:else}
        <ul class="m-0 flex list-none flex-col gap-1 p-0">
          {#each section.rows as r, i (i)}
            <li class="min-w-0 break-words">{@render row(r)}</li>
          {/each}
        </ul>
        {#if section.truncated}<p class="m-0 text-dark-2">Showing the newest {section.rows.length}.</p>{/if}
      {/if}
    </div>
  {/if}
{/snippet}

<TriageCard title="History" dense>
  {#if history.status === 'unlinked'}
    <p class="m-0 text-dark-2">No linked Civitai account — history unavailable</p>
  {:else if history.status === 'unavailable'}
    <p class="m-0 text-amber-300">
      History unavailable.
      <a class={LINK_CLASS} href={userLookupUrl(history.userId, 'basic')}>User #{history.userId}</a>
    </p>
  {:else}
    <div class="flex flex-col gap-3">
      {#snippet strike(s: HistoryStrike)}
        <span class="text-white">{spaced(s.reason)}</span>
        · {s.status}{s.imported ? ' (imported)' : ''} · {s.points} pt
        · <span class="text-dark-2" title={dateTime(s.createdAt)}>{relativeTime(s.createdAt)}</span>
        {#if s.issuedByName}<span class="text-dark-2"> by {s.issuedByName}</span>{/if}
      {/snippet}
      {@render block('Strikes', history.strikes, 'notes', 'No strikes.', strike)}

      {#snippet note(n: HistoryNote)}
        <span class="whitespace-pre-wrap">{n.text || '(empty note)'}</span>
        <span class="text-dark-2">
          {#if n.by}— {n.by}{/if}{#if n.at}
            · <span title={dateTime(n.at)}>{relativeTime(n.at)}</span>{/if}
        </span>
      {/snippet}
      {@render block('Notes', history.notes, 'notes', 'No notes.', note)}

      {#snippet activity(a: HistoryActivity)}
        <span class="text-white">{spaced(a.activity)}</span>
        · {a.entityType}{a.entityId ? ` #${a.entityId}` : ''}
        · <span class="text-dark-2" title={dateTime(a.at)}>{relativeTime(a.at)}</span>
        {#if a.moderator}<span class="text-dark-2"> by {a.moderator}</span>{/if}
      {/snippet}
      {@render block('Moderation activity', history.activity, 'mod-activity', 'No recorded moderation activity.', activity)}

      {#snippet removal(r: HistoryRemoval)}
        <span class="text-white">{r.type === 'Restore' ? 'Restored' : r.type === 'DeleteTOS' ? 'Removed (ToS)' : 'Deleted'}</span>
        · image #{r.imageId}{r.reason ? ` · ${r.reason}` : ''}
        · <span class="text-dark-2" title={dateTime(r.at)}>{relativeTime(r.at)}</span>
        {#if r.actor}<span class="text-dark-2"> by {r.actor}</span>{/if}
      {/snippet}
      {@render block('Image removals', history.removals, 'mod-activity', 'No image removals.', removal)}
    </div>
  {/if}
</TriageCard>
