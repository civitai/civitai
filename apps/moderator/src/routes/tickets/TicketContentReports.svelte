<script lang="ts">
  import TriageCard from '$lib/components/triage/TriageCard.svelte';
  import { userLookupUrl, userReportUrl } from '$lib/entity-url';
  import { LINK_CLASS, dateTime, relativeTime } from '$lib/format';
  import type { Snippet } from 'svelte';
  import type { TicketContentIssue, ContentReport } from '$lib/server/tickets/content-reports';
  import type { HistoryRemoval, HistorySection } from '$lib/server/tickets/history';

  let { content }: { content: TicketContentIssue } = $props();

  const spaced = (s: string) => s.replace(/([a-z])([A-Z])/g, '$1 $2');
</script>

{#snippet block<T>(
  title: string,
  section: HistorySection<T>,
  href: string,
  linkLabel: string,
  empty: string,
  row: Snippet<[T]>
)}
  <div class="flex flex-col gap-1">
    <div class="flex items-baseline justify-between gap-2">
      <span class="font-medium text-white">{title}</span>
      <a class={LINK_CLASS} {href}>{linkLabel}</a>
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
{/snippet}

<TriageCard title="Content issue" dense>
  {#if content.status === 'unlinked'}
    <p class="m-0 text-dark-2">No linked Civitai account — reports and removals unavailable</p>
  {:else if content.status === 'unavailable'}
    <p class="m-0 text-amber-300">
      Content issue context unavailable.
      <a class={LINK_CLASS} href={userLookupUrl(content.userId, 'basic')}>User #{content.userId}</a>
    </p>
  {:else}
    <div class="flex flex-col gap-3">
      {#snippet report(r: ContentReport)}
        <span class="text-white">{spaced(r.reason)}</span>
        · {r.status}
        · <span class="text-dark-2" title={dateTime(r.createdAt)}>{relativeTime(r.createdAt)}</span>
        {#if r.reporter}<span class="text-dark-2"> by {r.reporter}</span>{/if}
      {/snippet}
      {#if content.reports}
        {@render block('Open reports on the user', content.reports, userReportUrl(content.userId), 'Report queue', 'No open reports.', report)}
      {/if}

      {#snippet removal(r: HistoryRemoval)}
        <span class="text-white">{r.type === 'Restore' ? 'Restored' : r.type === 'DeleteTOS' ? 'Removed (ToS)' : 'Deleted'}</span>
        · image #{r.imageId}{r.reason ? ` · ${r.reason}` : ''}
        · <span class="text-dark-2" title={dateTime(r.at)}>{relativeTime(r.at)}</span>
        {#if r.actor}<span class="text-dark-2"> by {r.actor}</span>{/if}
      {/snippet}
      {#if content.removals}
        {@render block('Image removals', content.removals, userLookupUrl(content.userId, 'mod-activity'), content.removals.status === 'ok' && content.removals.truncated ? 'All in User Lookup' : 'User Lookup', 'No image removals.', removal)}
      {/if}
    </div>
  {/if}
</TriageCard>
