<script lang="ts">
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { LINK_CLASS, dateTime, num } from '$lib/format';
  import { chatUrl, urlWith } from '../url';
  import type { PageData } from './$types';

  type Search = NonNullable<PageData['search']>;

  let { search, chatId }: { search: Search; chatId: number | null } = $props();

  const MODE_LABEL: Record<Search['mode'], string> = {
    chat: 'chat id',
    user: 'username',
    content: 'message text',
  };
</script>

<section class="mb-4 rounded-xl border border-dark-4 bg-dark-6 p-5">
  <h3 class="mb-1 text-sm font-semibold text-white">
    Chats ({num(search.chats.length)}{search.truncated ? '+' : ''}) — matched on {MODE_LABEL[
      search.mode
    ]}
  </h3>
  <p class="mb-3 text-xs text-dark-2">
    A number is read as a chat id, a name as a username, anything else as message text. Prefix with
    <code>@</code> to force a username.
  </p>

  <!-- A numeric term is a valid chat id AND a valid username, and guessing wrong means showing two
       unrelated people's private conversation. Offer the other reading rather than deciding silently. -->
  {#if search.ambiguousUsername}
    <p class="mb-3 rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-sm text-amber-200">
      <strong>{search.term}</strong> is also a username. This is showing chat {search.term} —
      <a href={urlWith({ q: `@${search.term}`, chat: null, rpage: null })} class={LINK_CLASS}>
        search for the user instead
      </a>.
    </p>
  {/if}

  {#if search.truncated}
    <p class="mb-2 text-xs text-amber-300">
      More than {num(search.chats.length)} chats match — only the most recent are shown.
    </p>
  {/if}

  {#if search.chats.length === 0}
    <p class="text-sm text-dark-2">No chats matched.</p>
  {:else}
    <ul class="space-y-1.5 text-sm">
      {#each search.chats as chat (chat.chatId)}
        <li
          class="flex flex-wrap items-baseline gap-x-2 rounded-md px-2 py-1 {chat.chatId === chatId
            ? 'bg-dark-5'
            : ''}"
        >
          <a href={chatUrl(chat.chatId)} class={LINK_CLASS}>
            chat {chat.chatId}
          </a>
          <span class="text-dark-0">{chat.owner ?? (chat.ownerId ? `#${chat.ownerId}` : 'no owner')}</span>
          {#if chat.ownerBannedAt}
            <Badge variant="destructive">owner banned</Badge>
          {/if}
          {#if chat.members.length}
            <span class="line-clamp-1 text-xs text-dark-2">with {chat.members.join(', ')}</span>
          {/if}
          <span class="text-xs text-dark-2">
            {num(chat.messages)} messages · last {dateTime(chat.lastAt)}
          </span>
        </li>
      {/each}
    </ul>
  {/if}
</section>
