<script lang="ts">
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';
  import { chatAuditChatUrl, userLookupUrl } from '$lib/entity-url';
  import { dateTime, LINK_CLASS } from '$lib/format';
  import { formatChatAuditCursor, type ChatAuditCursor } from '$lib/chat-audit-cursor';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  const TYPES = ['edit', 'delete', 'clear', 'read'] as const;

  const href = (
    over: { chat?: number; actor?: number; type?: string; before?: ChatAuditCursor | null } = {}
  ) => {
    const f = { chat: data.filter.chat, actor: data.filter.actor, type: data.filter.type, ...over };
    const params = new URLSearchParams();
    if (f.chat) params.set('chat', String(f.chat));
    if (f.actor) params.set('actor', String(f.actor));
    if (f.type) params.set('type', f.type);
    if (over.before)
      params.set('before', formatChatAuditCursor(over.before));
    return `/retool/chat-audit-log${params.size ? `?${params}` : ''}`;
  };
</script>

<h2 class="m-0 mb-1 text-base font-semibold text-white">Chat audit log</h2>
<p class="mb-4 text-sm text-dark-2">
  Edits, deletes and clears of chat messages, and every time a moderator read a conversation. No message
  text here: open the chat to read it, which is itself recorded.
</p>

<form method="GET" class="mb-4 flex flex-wrap items-end gap-2">
  <label class="text-xs text-dark-2">
    Chat id
    <Input name="chat" value={data.filter.chat ?? ''} inputmode="numeric" class="w-32" />
  </label>
  <label class="text-xs text-dark-2">
    Actor user id
    <Input name="actor" value={data.filter.actor ?? ''} inputmode="numeric" class="w-32" />
  </label>
  <label class="text-xs text-dark-2">
    Event
    <select
      name="type"
      class="block h-9 rounded-md border border-dark-4 bg-dark-7 px-2 text-sm text-dark-0"
    >
      <option value="" selected={!data.filter.type}>Any</option>
      {#each TYPES as t (t)}
        <option value={t} selected={data.filter.type === t}>{t}</option>
      {/each}
    </select>
  </label>
  <Button type="submit" variant="outline">Filter</Button>
  {#if data.filter.chat || data.filter.actor || data.filter.type}
    <a href="/retool/chat-audit-log" class="text-sm {LINK_CLASS}">Clear</a>
  {/if}
</form>

{#if data.error}
  <ErrorAlert message={data.error} />
{:else if data.events.length}
  <div class="overflow-x-auto rounded-xl border border-dark-4 bg-dark-6">
    <table class="w-full text-sm">
      <thead>
        <tr class="border-b border-dark-4 text-left text-xs uppercase tracking-wider text-dark-2">
          <th class="px-4 py-3 font-semibold">When</th>
          <th class="px-4 py-3 font-semibold">Event</th>
          <th class="px-4 py-3 font-semibold">Chat</th>
          <th class="px-4 py-3 font-semibold">Message</th>
          <th class="px-4 py-3 font-semibold">By</th>
          <th class="px-4 py-3 font-semibold">Whose</th>
        </tr>
      </thead>
      <tbody>
        <!-- Indexed: two reads of one chat by one moderator in the same millisecond share every column. -->
        {#each data.events as e, i (`${e.cursor.at}_${i}`)}
          <tr class="border-b border-dark-7/60 last:border-0">
            <td class="px-4 py-2 font-mono text-xs text-dark-2">{dateTime(e.at)}</td>
            <td class="px-4 py-2">
              <a href={href({ type: e.type })} class={LINK_CLASS}>{e.type}</a>
            </td>
            <td class="px-4 py-2">
              {#if e.chatId}
                <a href={chatAuditChatUrl(e.chatId)} class={LINK_CLASS}>chat {e.chatId}</a>
                <a href={href({ chat: e.chatId })} class="ml-1 text-xs text-dark-2 hover:underline">
                  filter
                </a>
              {:else}
                <span class="text-dark-2" title="Not one conversation: an account's messages across chats">—</span>
              {/if}
            </td>
            <td class="px-4 py-2 text-dark-1">{e.messageId || '—'}</td>
            <td class="px-4 py-2">
              <a href={userLookupUrl(e.actorId)} class={LINK_CLASS}>{e.actorName ?? `#${e.actorId}`}</a>
              {#if e.actorRole === 'moderator'}<Badge variant="secondary">moderator</Badge>{/if}
              <a href={href({ actor: e.actorId })} class="ml-1 text-xs text-dark-2 hover:underline">
                filter
              </a>
            </td>
            <td class="px-4 py-2">
              {#if e.subjectId}
                <a href={userLookupUrl(e.subjectId)} class={LINK_CLASS}>
                  {e.subjectName ?? `#${e.subjectId}`}
                </a>
              {:else}
                <span class="text-dark-2">—</span>
              {/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
  {#if data.next}
    <Button href={href({ before: data.next })} variant="outline" size="sm" class="mt-4">Older</Button>
  {/if}
{:else}
  <p class="text-sm text-dark-2">No events match.</p>
{/if}
