<script lang="ts">
  import { page } from '$app/state';
  import { USER_MESSAGES_BEFORE } from '$lib/chat-transcript-cursor';
  import { urlWith } from '$lib/url';
  import ShowMoreButton from '$lib/components/ShowMoreButton.svelte';
  import { LINK_CLASS, num } from '$lib/format';
  import MessageMeta from '$lib/components/chat-audit/MessageMeta.svelte';
  import { chatUrl } from '../url';
  import type { PageData } from './$types';

  type Messages = NonNullable<PageData['userMessages']>;

  let { messages }: { messages: Messages } = $props();

  const SHOWN = 15;
  // Keyed to the page's first message, so a page turn opens collapsed like the first page did.
  let expandedFor = $state<number | null>(null);
  const expanded = $derived(!!messages.rows[0] && expandedFor === messages.rows[0].id);
  const visible = $derived(expanded ? messages.rows : messages.rows.slice(0, SHOWN));

  const pageHref = (before: number | null) => urlWith(page.url, { [USER_MESSAGES_BEFORE]: before });
  const oldest = $derived(messages.rows.at(-1));
</script>

<section class="mb-4 min-w-0 rounded-xl border border-dark-4 bg-dark-6 p-5">
  <h3 class="mb-1 text-sm font-semibold text-white">
    What they said ({num(messages.rows.length)}{messages.truncated || messages.hasNewer
      ? ' on this page'
      : ''})
  </h3>
  <p class="mb-3 text-xs text-dark-2">
    Every message this account sent, newest first, across {num(messages.chats)}
    {messages.chats === 1 ? 'chat' : 'chats'}.
  </p>

  {#snippet pager(top: boolean)}
    {#if messages.truncated || messages.hasNewer}
      <nav
        aria-label={top ? 'Message pages' : 'Message pages, bottom'}
        class="my-2 flex flex-wrap items-center gap-3 text-xs"
        data-sveltekit-noscroll
      >
        {#if messages.hasNewer}
          <a href={pageHref(null)} class={LINK_CLASS}>← Newest</a>
        {/if}
        {#if messages.truncated && oldest}
          <a href={pageHref(oldest.id)} class={LINK_CLASS}>Older messages →</a>
        {/if}
      </nav>
    {/if}
  {/snippet}

  {@render pager(true)}

  {#if messages.rows.length === 0}
    <p class="text-sm text-dark-2">
      {messages.hasNewer ? 'No older messages.' : 'This account has never sent a message.'}
    </p>
  {:else}
    <ul class="space-y-2 text-sm">
      {#each visible as m (m.id)}
        <li class="min-w-0">
          <MessageMeta {...m} chatHref={chatUrl} />
          <p class="min-w-0 wrap-break-word whitespace-pre-wrap text-dark-0">{m.content}</p>
        </li>
      {/each}
    </ul>
    <ShowMoreButton
      total={messages.rows.length}
      shown={SHOWN}
      {expanded}
      capped={messages.truncated}
      onToggle={() => (expandedFor = expanded ? null : (messages.rows[0]?.id ?? null))}
    />
  {/if}
  {@render pager(false)}
</section>
