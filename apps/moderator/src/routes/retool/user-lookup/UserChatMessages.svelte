<script lang="ts">
  import { browser } from '$app/environment';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { LINK_CLASS, dateTime, num } from '$lib/format';
  import { chatAuditChatUrl } from '$lib/entity-url';
  import type { Jsonified } from '$lib/format';
  import type { UserMessages } from '$lib/server/chat-audit.service';

  let { userId }: { userId: number } = $props();

  type Messages = Jsonified<UserMessages>;

  async function fetchMessages(id: number): Promise<Messages> {
    const r = await fetch(`/api/user-chat-messages/${id}`);
    if (!r.ok) throw new Error(String(r.status));
    return r.json();
  }

  const messages = $derived(browser ? fetchMessages(userId) : null);
</script>

<section class="mb-4 rounded-xl border border-dark-4 bg-dark-6 p-5">
  <h3 class="mb-1 text-sm font-semibold text-white">What they said</h3>
  <p class="mb-3 text-xs text-dark-2">
    The newest private messages this account sent, so spam or harassment can be read here rather than
    reconstructed from a list of chat ids. Open a chat for the other side of the conversation.
  </p>

  {#await messages}
    <p class="text-sm text-dark-2">Loading messages…</p>
  {:then result}
    {#if !result}
      <p class="text-sm text-dark-2">Loading messages…</p>
    {:else if result.rows.length === 0}
      <p class="text-sm text-dark-2">This account has never sent a message.</p>
    {:else}
      <p class="mb-2 text-xs text-dark-2">
        {num(result.rows.length)}{result.truncated ? '+' : ''} shown, across {num(result.chats)}
        {result.chats === 1 ? 'chat' : 'chats'} in total.
      </p>
      <ul class="space-y-2 text-sm">
        {#each result.rows as m (m.id)}
          <li class="min-w-0 {m.deletedAt ? 'border-l-2 border-red-500/50 pl-2' : ''}">
            <div class="flex flex-wrap items-baseline gap-x-2">
              <a href={chatAuditChatUrl(m.chatId)} class="text-xs {LINK_CLASS}">chat {m.chatId}</a>
              <span class="text-xs text-dark-2">{dateTime(m.createdAt)}</span>
              {#if m.editedAt}<Badge variant="secondary">edited</Badge>{/if}
              {#if m.deletedAt}<Badge variant="destructive">deleted</Badge>{/if}
            </div>
            <p class="min-w-0 wrap-break-word whitespace-pre-wrap text-dark-0">{m.content}</p>
          </li>
        {/each}
      </ul>
    {/if}
  {:catch}
    <p class="text-sm text-red-300">Could not load messages.</p>
  {/await}
</section>
