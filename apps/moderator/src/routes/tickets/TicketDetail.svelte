<script lang="ts">
  import { userLookupUrl } from '$lib/entity-url';
  import { LINK_CLASS, dateTime } from '$lib/format';
  import TicketEscalate from './TicketEscalate.svelte';
  import TicketReply from './TicketReply.svelte';
  import type { loadTicketDetail } from '$lib/server/tickets/detail';

  let { data }: { data: Awaited<ReturnType<typeof loadTicketDetail>> } = $props();

  const t = $derived(data.ticket);
  const sentByLabel = $derived(t.sentBy?.username ?? (t.sentBy ? `user ${t.sentBy.moderatorId}` : null));
  const email = $derived('requesterEmail' in t ? (t.requesterEmail ?? '—') : null);
</script>

<header class="page-header">
  <h1>#{t.id} {t.subject}</h1>
  <p class="text-dark-2">
    <a class={LINK_CLASS} href={t.freshdeskUrl} target="_blank" rel="noreferrer">Freshdesk ↗</a>
    · {t.statusLabel} · created {dateTime(t.createdAt)}
  </p>
</header>

<p class="mb-4">
  <a class={LINK_CLASS} href="/tickets/{data.view}"
    >← {data.view === 'moderation' ? 'Moderation' : 'Support'} tickets</a
  >
</p>

<section class="mb-4 rounded-xl border border-dark-4 bg-dark-6 p-5">
  <dl class="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
    <dt class="text-dark-2">Feature</dt>
    <dd>{t.cfFeature ?? 'none'}</dd>
    {#if t.routerTopic}
      <dt class="text-dark-2">Router topic</dt>
      <dd>{t.routerTopic}</dd>
    {/if}
    <dt class="text-dark-2">Requester</dt>
    <dd>{t.requesterName ?? '—'}</dd>
    {#if email !== null}
      <dt class="text-dark-2">Email</dt>
      <dd>{email}</dd>
    {/if}
    <dt class="text-dark-2">Civitai account</dt>
    <dd>
      {#if t.civitaiUserId}
        <a class={LINK_CLASS} href={userLookupUrl(t.civitaiUserId, 'basic')}>user {t.civitaiUserId}</a
        >
      {:else}
        <span class="text-dark-2">no linked Civitai account</span>
      {/if}
    </dd>
    {#if t.sentToSupport}
      <dt class="text-dark-2">Sent to support</dt>
      <dd>
        {#if t.sentBy}
          by {sentByLabel} · {dateTime(t.sentBy.at)}
        {:else}
          <span class="text-dark-2">by whom is not recorded</span>
        {/if}
      </dd>
    {/if}
    <dt class="text-dark-2">Updated</dt>
    <dd>{dateTime(t.updatedAt)}</dd>
  </dl>
</section>

<!-- 🔴 TEXT, NEVER `{@html}`: the description and every message are customer-written. -->
<section class="mb-4 rounded-xl border border-dark-4 bg-dark-6 p-5">
  <h2 class="mb-2 text-white">Ticket</h2>
  {#if t.description.status === 'found'}
    <p class="break-words whitespace-pre-wrap">{t.description.text}</p>
    {#if t.description.truncated}
      <p class="text-dark-2 mt-2 text-xs">Cut short here — the rest is in Freshdesk.</p>
    {/if}
  {:else if t.description.status === 'none'}
    <p class="text-dark-2">Freshdesk has no description for this ticket.</p>
  {:else}
    <p class="text-dark-2">{t.description.reason}</p>
  {/if}
</section>

<section class="rounded-xl border border-dark-4 bg-dark-6 p-5">
  <h2 class="mb-2 text-white">Conversation</h2>
  <p class="text-dark-2 mb-3 text-xs">
    Customer messages and public agent replies. Private notes are not shown.
  </p>
  {#await data.conversation}
    <p class="text-dark-2">Loading the conversation from Freshdesk…</p>
  {:then c}
    {#if c.status === 'found'}
      {#if c.messages.length === 0}
        <p class="text-dark-2">No messages beyond the original ticket.</p>
      {/if}
      <ol class="flex flex-col gap-3">
        {#each c.messages as m (m.conversationId)}
          <li class="rounded-lg border border-dark-4 p-3">
            <p class="text-dark-2 mb-1 text-xs">
              {m.from === 'customer' ? 'Customer' : 'Agent'} · {dateTime(m.createdAt)}
            </p>
            <p class="break-words whitespace-pre-wrap">{m.text}</p>
          </li>
        {/each}
      </ol>
      {#if c.truncated}
        <p class="text-dark-2 mt-2 text-xs">
          Only the earliest messages are shown — the rest is in Freshdesk.
        </p>
      {/if}
    {:else}
      <p class="text-red-400">Could not read the conversation: {c.reason}</p>
    {/if}
  {:catch}
    <p class="text-red-400">Could not read the conversation.</p>
  {/await}
</section>

{#if data.canReply}
  <TicketReply ticketId={t.id} view={data.view} currentStatus={t.status} />
{/if}

{#if data.canEscalate}
  <TicketEscalate ticketId={t.id} />
{/if}
