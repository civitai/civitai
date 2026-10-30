<script lang="ts">
  import TriageCard from '$lib/components/triage/TriageCard.svelte';
  import { userLookupUrl, userReportUrl } from '$lib/entity-url';
  import { dateTime, relativeTime } from '$lib/format';
  import { reportStatusLabel, spaced } from '$lib/tickets/labels';
  import type { TicketContentIssue, ContentReport } from '$lib/server/tickets/content-reports';
  import type { HistoryRemoval } from '$lib/server/tickets/history';
  import TicketCardState from './TicketCardState.svelte';
  import TicketSection from './TicketSection.svelte';

  let { content }: { content: TicketContentIssue } = $props();
</script>

<TriageCard title="Content issue" dense>
  {#if content.status !== 'ok'}
    <TicketCardState
      card={content}
      unlinked="reports and removals unavailable"
      unavailable="Content issue context unavailable."
    />
  {:else}
    <div class="flex flex-col gap-3">
      {#snippet report(r: ContentReport)}
        <span class="text-white">{spaced(r.reason)}</span>
        · {reportStatusLabel(r.status)}
        · <span class="text-dark-2" title={dateTime(r.createdAt)}>{relativeTime(r.createdAt)}</span>
        {#if r.reporter}<span class="text-dark-2"> by {r.reporter}</span>{/if}
      {/snippet}
      {#if content.reports}
        <!-- Keyed by position: one report spans several rows, one per reported item, so its id repeats. -->
        <TicketSection
          title="Open reports on the user's content"
          section={content.reports}
          href={userReportUrl(content.userId)}
          linkLabel="User report queue"
          truncatedLabel="User report queue"
          empty="No open reports on their content."
          row={report}
        />
      {/if}

      {#snippet removal(r: HistoryRemoval)}
        <span class="text-white">{r.type === 'Restore' ? 'Restored' : r.type === 'DeleteTOS' ? 'Removed (ToS)' : 'Deleted'}</span>
        · image #{r.imageId}{r.reason ? ` · ${r.reason}` : ''}
        · <span class="text-dark-2" title={dateTime(r.at)}>{relativeTime(r.at)}</span>
        {#if r.actor}<span class="text-dark-2"> by {r.actor}</span>{/if}
      {/snippet}
      {#if content.removals}
        <TicketSection
          title="Image removals"
          section={content.removals}
          href={userLookupUrl(content.userId, 'mod-activity')}
          empty="No image removals."
          row={removal}
          rowKey={(r) => r.key}
        />
      {/if}
    </div>
  {/if}
</TriageCard>
