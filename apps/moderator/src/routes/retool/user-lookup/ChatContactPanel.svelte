<script lang="ts">
  import { LINK_CLASS, dateTime, num } from '$lib/format';
  import type { ModeratorContact } from '$lib/server/user-signals.service';

  let { modContact }: { modContact: ModeratorContact } = $props();
</script>

<section class="mb-4 rounded-xl border border-dark-4 bg-dark-6 p-5">
  <h3 class="mb-1 text-sm font-semibold text-white">Chat (DMs)</h3>
  <p class="mb-3 text-xs text-dark-2">
    Whether this account has spoken with a moderator. Transcripts live in Chat Audit — this is the
    prior-context warning, not a chat browser.
  </p>

  {#if modContact.chats === null}
    <p class="text-sm text-red-300">Could not check moderator contact — treat as unknown, not none.</p>
  {:else if modContact.chats === 0}
    <p class="text-sm text-dark-2">No moderator contact on record.</p>
  {:else}
    <div class="rounded-md border border-blue-500/30 bg-blue-500/10 p-2 text-sm text-blue-200">
      This account has spoken with a moderator in {num(modContact.chats)}
      {modContact.chats === 1 ? 'chat' : 'chats'} — most recently {dateTime(modContact.lastAt)}.
      Check for prior context before acting.
    </div>
    <!-- The ticket asked for the chat ids, not just the fact: without them finding the conversation
         means searching Chat Audit by username and guessing which thread. Newest first, capped. -->
    <ul class="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-sm">
      {#each modContact.chatIds as id (id)}
        <li>
          <a href="/retool/chat-audit/search?q={id}" class={LINK_CLASS}>chat {id}</a>
        </li>
      {/each}
      {#if modContact.chats > modContact.chatIds.length}
        <li class="text-xs text-dark-2">
          +{num(modContact.chats - modContact.chatIds.length)} more
        </li>
      {/if}
    </ul>
  {/if}
</section>
