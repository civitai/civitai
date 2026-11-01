<script lang="ts">
  import { browser } from '$app/environment';
  import MetaChip from '$lib/components/minor-flags/MetaChip.svelte';
  import MessageMeta from '$lib/components/chat-audit/MessageMeta.svelte';
  import TriageCard from '$lib/components/triage/TriageCard.svelte';
  import { fetchHoldChat } from '$lib/csam-holds/hold-chat';
  import { chatAuditChatUrl } from '$lib/entity-url';
  import { LINK_CLASS, plural } from '$lib/format';

  let { holdId, chatId }: { holdId: number; chatId: number } = $props();

  // Bumped by "Try again" to re-run the derived request; failures are not cached.
  let attempt = $state(0);
  // Client only: a relative fetch during server rendering throws.
  const chat = $derived.by(() => {
    void attempt;
    return browser ? fetchHoldChat(holdId) : new Promise<never>(() => {});
  });
</script>

<TriageCard dense title="Conversation">
  {#await chat}
    <p class="m-0 text-dark-2" role="status">Loading the conversation…</p>
  {:then loaded}
    {@const judged = new Set(loaded.judgedIds)}
    <p class="m-0 mb-2 text-[11px] text-dark-2">
      {#if loaded.fullConversation}
        {plural(judged.size, 'judged message')} highlighted, with the messages around
        {judged.size === 1 ? 'it' : 'them'}. System messages are left out.
        <a href={chatAuditChatUrl(chatId)} class={LINK_CLASS}>Open in chat audit</a>
      {:else}
        Full conversation needs Chat Audit access. Only the sender's judged
        {judged.size === 1 ? 'message is' : 'messages are'} shown.
      {/if}
    </p>
    {#if loaded.omitted}
      <p class="m-0 mb-2 flex flex-wrap items-center gap-x-2 text-[11px] text-dark-2" role="status">
        <MetaChip tone="amber">{plural(loaded.omitted, 'message')} not shown</MetaChip>
        <a href={chatAuditChatUrl(chatId)} class={LINK_CLASS}>Open in chat audit</a>
      </p>
    {/if}
    <!-- Focusable so a keyboard user can scroll the conversation (WCAG 2.1.1). -->
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <ol
      tabindex="0"
      aria-label="Conversation"
      class="m-0 max-h-[28rem] list-none space-y-1.5 overflow-y-auto p-0"
    >
      {#each loaded.messages as message (message.id)}
        {@const isJudged = judged.has(message.id)}
        {@const fromSender = message.userId === loaded.senderId}
        <li
          class={[
            'rounded-md border-l-[3px] px-2.5 py-1.5',
            isJudged
              ? 'border-l-red-500 bg-red-500/10'
              : fromSender
                ? 'border-l-blue-500/60 bg-dark-6'
                : 'ml-6 border-l-dark-4 bg-dark-6/50',
          ]}
          aria-current={isJudged ? 'true' : undefined}
        >
          <MessageMeta
            userId={message.userId}
            username={message.username}
            bannedAt={message.bannedAt}
            createdAt={message.createdAt}
            editedAt={message.editedAt}
            deletedAt={message.deletedAt}
            judged={isJudged}
            sender={fromSender}
          />
          <p class="m-0 mt-0.5 break-words whitespace-pre-wrap text-dark-0">{message.content}</p>
        </li>
      {/each}
    </ol>
  {:catch}
    <p class="m-0 text-sm text-dark-0" role="alert">
      Could not load the conversation.
      <button type="button" class={LINK_CLASS} onclick={() => attempt++}>Try again</button>
    </p>
  {/await}
</TriageCard>
