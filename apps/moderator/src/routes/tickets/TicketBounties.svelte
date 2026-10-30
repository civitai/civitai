<script lang="ts">
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import TriageCard from '$lib/components/triage/TriageCard.svelte';
  import { userLookupUrl } from '$lib/entity-url';
  import { LINK_CLASS, dateTime, num, relativeTime } from '$lib/format';
  import type { Snippet } from 'svelte';
  import type { BountyEntryRow, BountyRow, TicketBounties } from '$lib/server/tickets/bounties';
  import type { HistorySection } from '$lib/server/tickets/history';

  let { bounties: data }: { bounties: TicketBounties } = $props();
</script>

{#snippet block<T>(title: string, section: HistorySection<T>, empty: string, row: Snippet<[T]>)}
  <div class="flex flex-col gap-1">
    <span class="font-medium text-white">{title}</span>
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

{#snippet funded(b: BountyRow)}
  <span class="text-white">{b.name}</span>
  <Badge variant={b.complete ? 'secondary' : 'outline'}>{b.complete ? 'Complete' : 'Open'}</Badge>
  · {b.type} · {num(b.pledged)} Buzz
  · <span class="text-dark-2" title={dateTime(b.createdAt)}>{relativeTime(b.createdAt)}</span>
  <span class="text-dark-2"> · ends {dateTime(b.expiresAt)}</span>
{/snippet}

{#snippet entered(e: BountyEntryRow)}
  <span class="text-white">{e.bountyName}</span>
  · entry #{e.id}
  · <span class="text-dark-2" title={dateTime(e.createdAt)}>{relativeTime(e.createdAt)}</span>
{/snippet}

<TriageCard title="Bounties" dense>
  {#if data.status === 'unlinked'}
    <p class="m-0 text-dark-2">No linked Civitai account — bounties unavailable</p>
  {:else if data.status === 'unavailable'}
    <p class="m-0 text-amber-300">
      Bounties unavailable.
      <a class={LINK_CLASS} href={userLookupUrl(data.userId, 'bounties')}>User #{data.userId}</a>
    </p>
  {:else}
    <div class="flex flex-col gap-3">
      <div class="flex justify-end">
        <a class={LINK_CLASS} href={userLookupUrl(data.userId, 'bounties')}>User Lookup</a>
      </div>
      {@render block('Bounties funded', data.bounties, 'No bounties.', funded)}
      {@render block('Entries submitted', data.entries, 'No entries.', entered)}
    </div>
  {/if}
</TriageCard>
