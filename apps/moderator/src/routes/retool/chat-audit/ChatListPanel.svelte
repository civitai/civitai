<script lang="ts">
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { LINK_CLASS, dateTime, num } from '$lib/format';
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
    Chats ({search.chats.length}) — matched on {MODE_LABEL[search.mode]}
  </h3>
  <p class="mb-3 text-xs text-dark-2">
    Searching <code>{search.term}</code> as {MODE_LABEL[search.mode]}. A number is read as a chat id, a
    name as a username, anything else as message text.
  </p>

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
          <a href="?q={encodeURIComponent(search.term)}&chat={chat.chatId}" class={LINK_CLASS}>
            chat {chat.chatId}
          </a>
          <span class="text-dark-0">{chat.owner ?? `#${chat.ownerId}`}</span>
          {#if chat.ownerBannedAt}
            <Badge variant="destructive">owner banned</Badge>
          {/if}
          {#if chat.members.length}
            <span class="text-xs text-dark-2">with {chat.members.join(', ')}</span>
          {/if}
          <span class="text-xs text-dark-2">
            {num(chat.messages)} messages · last {dateTime(chat.lastAt)}
          </span>
        </li>
      {/each}
    </ul>
  {/if}
</section>
