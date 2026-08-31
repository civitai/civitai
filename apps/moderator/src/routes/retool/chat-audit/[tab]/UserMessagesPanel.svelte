<script lang="ts">
  import ShowMoreButton from '$lib/components/ShowMoreButton.svelte';
  import { num } from '$lib/format';
  import MessageMeta from './MessageMeta.svelte';
  import type { PageData } from './$types';

  type Messages = NonNullable<PageData['userMessages']>;

  let { messages }: { messages: Messages } = $props();

  const SHOWN = 15;
  let expanded = $state(false);
  const visible = $derived(expanded ? messages.rows : messages.rows.slice(0, SHOWN));
</script>

<section class="mb-4 min-w-0 rounded-xl border border-dark-4 bg-dark-6 p-5">
  <h3 class="mb-1 text-sm font-semibold text-white">
    What they said ({num(messages.rows.length)}{messages.truncated ? '+' : ''})
  </h3>
  <p class="mb-3 text-xs text-dark-2">
    Every message this account sent, newest first, across {num(messages.chats)}
    {messages.chats === 1 ? 'chat' : 'chats'}.
  </p>

  {#if messages.truncated}
    <p class="mb-2 text-xs text-amber-300">
      Capped — this account has sent more than are shown; older messages were dropped.
    </p>
  {/if}

  {#if messages.rows.length === 0}
    <p class="text-sm text-dark-2">This account has never sent a message.</p>
  {:else}
    <ul class="space-y-2 text-sm">
      {#each visible as m (m.id)}
        <li class="min-w-0">
          <MessageMeta {...m} />
          <p class="min-w-0 wrap-break-word whitespace-pre-wrap text-dark-0">{m.content}</p>
        </li>
      {/each}
    </ul>
    <ShowMoreButton
      total={messages.rows.length}
      shown={SHOWN}
      {expanded}
      capped={messages.truncated}
      onToggle={() => (expanded = !expanded)}
    />
  {/if}
</section>
