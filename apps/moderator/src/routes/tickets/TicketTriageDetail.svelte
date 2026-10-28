<script lang="ts">
  import { browser } from '$app/environment';
  import { invalidateAll } from '$app/navigation';
  import { toast } from '@civitai/ui/components/ui/sonner/index.js';
  import TriageCard from '$lib/components/triage/TriageCard.svelte';
  import TriageColumns from '$lib/components/triage/TriageColumns.svelte';
  import { userLookupUrl } from '$lib/entity-url';
  import { LINK_BUTTON, LINK_CLASS, dateTime, relativeTime } from '$lib/format';
  import { SSR_PENDING } from '$lib/ssr-pending';
  import type { TicketRow } from '$lib/server/tickets/list';
  import { fetchTicketPayload } from '$lib/tickets/fetch-detail';
  import { requesterLabel, sentByText } from '$lib/tickets/row';
  import { isLiveStatus } from '$lib/tickets/snapshot';
  import type { TicketView } from '$lib/tickets/routing';
  import TicketEscalate from './TicketEscalate.svelte';
  import TicketReply from './TicketReply.svelte';
  import TicketStatusBadge from './TicketStatusBadge.svelte';

  let {
    row,
    view,
    canReply,
    canEscalate,
    onleave,
  }: {
    row: TicketRow;
    view: TicketView;
    canReply: boolean;
    canEscalate: boolean;
    /** The ticket no longer belongs in this list (another view, or resolved): move to the next one. */
    onleave: (id: string) => void;
  } = $props();

  // Bumped by a write, so the conversation is read again to show what was just sent.
  let version = $state(0);
  // Fetched when a ticket opens, not with the list: it is a Freshdesk call per ticket. The server half
  // is `SSR_PENDING`, never null, or the browser's content would land outside its {#await} block.
  const payload = $derived.by(() => {
    void version;
    return browser ? fetchTicketPayload(row.id, view) : SSR_PENDING;
  });

  function done(what: string, data: Record<string, unknown> | undefined, status: number | null) {
    const moved = data?.moved;
    const warning = typeof data?.warning === 'string' ? data.warning : null;
    const left = moved === 'moderation' || moved === 'support';
    const resolved = status !== null && !isLiveStatus(status);
    if (left || resolved) {
      const where = left ? `${what}; it is now in the ${moved} view` : `${what}; it is closed out`;
      if (warning) toast.warning(`${where}. ${warning}`);
      else toast.success(where);
      onleave(row.id);
      return;
    }
    version += 1;
    void invalidateAll();
    if (!warning) toast.success(what);
  }

  const title = $derived(row.subject || '(no subject)');
</script>

{#snippet header()}
  <div class="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
    <div class="min-w-0 flex-1 basis-80 space-y-1.5">
      <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
        <h2 class="m-0 text-lg font-semibold break-words text-white">{title}</h2>
        <span class="text-[13px] text-dark-2 tabular-nums">#{row.id}</span>
        <TicketStatusBadge status={row.status} label={row.statusLabel} />
      </div>
      <p class="m-0 text-sm text-dark-2">
        created <span title={dateTime(row.createdAt)}>{relativeTime(row.createdAt)}</span>
        · updated <span title={dateTime(row.updatedAt)}>{relativeTime(row.updatedAt)}</span>
      </p>
    </div>
    <a class={LINK_BUTTON} href={row.freshdeskUrl} target="_blank" rel="noreferrer">Freshdesk ↗</a>
  </div>
{/snippet}

<!-- 🔴 TEXT, NEVER `{@html}`: the description and every message are customer-written. -->
{#snippet evidence()}
  {#await payload}
    <p class="m-0 text-sm text-dark-2">Loading the ticket from Freshdesk…</p>
  {:then p}
    <section class="mb-5">
      <h3 class="m-0 mb-2 text-[11px] font-semibold tracking-[0.5px] text-dark-2 uppercase">Ticket</h3>
      {#if p.ticket.description.status === 'found'}
        <p class="m-0 text-sm break-words whitespace-pre-wrap text-white">{p.ticket.description.text}</p>
        {#if p.ticket.description.truncated}
          <p class="m-0 mt-2 text-xs text-dark-2">Cut short here — the rest is in Freshdesk.</p>
        {/if}
      {:else if p.ticket.description.status === 'none'}
        <p class="m-0 text-sm text-dark-2">Freshdesk has no description for this ticket.</p>
      {:else}
        <p class="m-0 text-sm text-dark-2">{p.ticket.description.reason}</p>
      {/if}
    </section>

    <section>
      <h3 class="m-0 mb-1 text-[11px] font-semibold tracking-[0.5px] text-dark-2 uppercase">
        Conversation
      </h3>
      <p class="m-0 mb-3 text-xs text-dark-2">
        Customer messages and public agent replies, oldest first. Private notes are not shown.
      </p>
      {#if p.conversation.status === 'found'}
        {#if p.conversation.messages.length === 0}
          <p class="m-0 text-sm text-dark-2">No messages beyond the original ticket.</p>
        {/if}
        <ol class="m-0 flex list-none flex-col gap-3 p-0">
          {#each p.conversation.messages as m (m.conversationId)}
            <li class="rounded-lg border border-dark-4 bg-dark-7 p-3">
              <p class="m-0 mb-1 text-xs text-dark-2">
                {m.from === 'customer' ? 'Customer' : 'Agent'} · {dateTime(m.createdAt)}
              </p>
              <p class="m-0 text-sm break-words whitespace-pre-wrap text-white">{m.text}</p>
            </li>
          {/each}
        </ol>
        {#if p.conversation.truncated}
          <p class="m-0 mt-2 text-xs text-dark-2">
            Only the earliest messages are shown — the rest is in Freshdesk.
          </p>
        {/if}
      {:else}
        <p class="m-0 text-sm text-red-300">Could not read the conversation: {p.conversation.reason}</p>
      {/if}
    </section>
  {:catch err}
    <p class="m-0 text-sm text-red-300" role="alert">
      Could not read the ticket: {err instanceof Error ? err.message : 'Freshdesk could not be read.'}
    </p>
  {/await}
{/snippet}

<!-- The row already has everything but the tags, so the cards do not wait on the conversation. A linked
     account the detail read resolved from the address replaces the row's, once it arrives. -->
{#snippet info()}
  {#await payload}
    {@render cards(row.civitaiUserId, row.sentBy, null)}
  {:then p}
    {@render cards(p.ticket.civitaiUserId, p.ticket.sentBy, p.ticket.tags)}
  {:catch}
    {@render cards(row.civitaiUserId, row.sentBy, null)}
  {/await}
{/snippet}

{#snippet cards(
  civitaiUserId: number | null,
  sent: TicketRow['sentBy'],
  tags: string[] | null
)}
  {@const sentText = sentByText({ sentToSupport: row.sentToSupport, sentBy: sent })}
  <TriageCard title="Requester" dense>
    <dl class="m-0 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1">
      <dt class="text-dark-2">Name</dt>
      <dd class="m-0 min-w-0 break-words text-white">{requesterLabel({ requesterName: row.requesterName, civitaiUserId })}</dd>
      <!-- Present only for a viewer with the PII grant: the server omits the field otherwise. -->
      {#if row.requesterEmail !== undefined}
        <dt class="text-dark-2">Email</dt>
        <dd class="m-0 min-w-0 break-all text-white">{row.requesterEmail ?? '—'}</dd>
      {/if}
      <dt class="text-dark-2">Account</dt>
      <dd class="m-0">
        {#if civitaiUserId}
          <a class={LINK_CLASS} href={userLookupUrl(civitaiUserId, 'basic')}>User #{civitaiUserId}</a>
        {:else}
          <span class="text-dark-2">No linked Civitai account</span>
        {/if}
      </dd>
    </dl>
  </TriageCard>
  <TriageCard title="Ticket" dense>
    <dl class="m-0 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1">
      <dt class="text-dark-2">Feature</dt>
      <dd class="m-0 min-w-0 break-words text-white">
        {row.cfFeature ?? 'None'}
      </dd>
      {#if row.routerTopic}
        <dt class="text-dark-2">Router topic</dt>
        <dd class="m-0 min-w-0 break-words text-white">{row.routerTopic}</dd>
      {/if}
    </dl>
    {#if sentText}
      <p class="m-0 mt-1.5 text-white">
        {sentText}{#if sent}<span class="text-dark-2"> · {dateTime(sent.at)}</span>{/if}
      </p>
    {/if}
    {#if tags && tags.length > 0}
      <ul class="m-0 mt-2 flex list-none flex-wrap gap-1 p-0">
        {#each tags as tag (tag)}
          <li class="rounded-full border border-dark-4 px-2 py-px text-xs text-dark-1">{tag}</li>
        {/each}
      </ul>
    {/if}
  </TriageCard>
{/snippet}

{#snippet decision()}
  <TicketReply ticketId={row.id} currentStatus={row.status} {canReply} ondone={done} />
  {#if view === 'moderation'}
    <TicketEscalate ticketId={row.id} {canEscalate} ondone={done} />
  {/if}
{/snippet}

<TriageColumns verdict={undefined} error={undefined} {header} {evidence} {info} {decision} />
