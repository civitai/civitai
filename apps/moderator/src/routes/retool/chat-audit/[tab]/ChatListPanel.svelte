<script lang="ts">
  import { tick } from 'svelte';
  import { goto } from '$app/navigation';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { LINK_CLASS, dateTime, num } from '$lib/format';
  import { userLookupUrl } from '$lib/entity-url';
  import { isDialogOpen, isTypingTarget, listKeyAction } from '$lib/triage/keys';
  import { chatUrl, urlWith } from '../url';
  import type { PageData } from './$types';

  type Search = NonNullable<PageData['search']>;

  let { search, chatId }: { search: Search; chatId: number | null } = $props();

  const MODE_LABEL: Record<Search['mode'], string> = {
    chat: 'chat id',
    user: 'username',
    content: 'message text',
  };

  // A text or username search opens on the message its card shows; a chat id opens on the newest page.
  const href = (chat: Search['chats'][number]) =>
    chatUrl(chat.chatId, search.mode !== 'chat' ? chat.excerpt?.messageId : undefined);

  // Only Enter loads a transcript, which the Chat Audit Log records; moving the highlight reads nothing.
  // Remembered against the chat that was open, so opening another one moves the highlight to it.
  let moved = $state<{ from: number | null; index: number } | null>(null);
  const highlighted = $derived(
    moved && moved.from === chatId
      ? moved.index
      : search.chats.findIndex((c) => c.chatId === chatId)
  );
  const rows: HTMLElement[] = [];

  const firstShown = $derived((search.page - 1) * search.perPage + 1);
  // The open chat stays open across pages; page 1 is the canonical default and leaves the URL.
  const pageHref = (n: number) => urlWith({ spage: n > 1 ? n : null });

  async function onkeydown(e: KeyboardEvent) {
    if (!search.chats.length) return;
    const target = e.target instanceof Element ? e.target : null;
    const action = listKeyAction({
      key: e.key,
      ctrlKey: e.ctrlKey,
      metaKey: e.metaKey,
      altKey: e.altKey,
      defaultPrevented: e.defaultPrevented,
      isComposing: e.isComposing,
      typing: isTypingTarget(target),
      dialogOpen: isDialogOpen(),
      onControl: !!target?.closest('button, a, summary'),
    });
    if (!action) return;
    if (action === 'open') {
      const chat = search.chats[highlighted];
      // Reopening the open chat would only log another read.
      if (chat && !e.repeat && chat.chatId !== chatId) goto(href(chat), { noScroll: true });
      return;
    }
    const last = search.chats.length - 1;
    const index =
      action === 'next' ? Math.min(highlighted + 1, last) : Math.max(highlighted - 1, 0);
    moved = { from: chatId, index };
    await tick();
    rows[index]?.scrollIntoView({ block: 'nearest' });
  }
</script>

<svelte:window {onkeydown} />

<!-- The report queues' column shape (`ReportQueueColumn`). -->
<section class="flex min-h-0 flex-1 flex-col">
  <div class="shrink-0 space-y-2 border-b border-dark-4 px-3 py-2.5 text-xs text-dark-2">
    <p class="m-0">
      Matched on <span class="text-dark-0">{MODE_LABEL[search.mode]}</span>{#if search.mode === 'content'}
        over the last {search.contentSearchDays} days{/if}. A number is read as a chat id, a name as a
      username, anything else as message text; <code>@</code> forces a username.
      <kbd>k</kbd>/<kbd>j</kbd> move down and up, <kbd>Enter</kbd> opens.
    </p>
    {#if search.slow}
      <p class="m-0 text-amber-300">
        Message-text search is not indexed: each page scans every message from the last
        {search.contentSearchDays} days, so it is slow.
      </p>
    {/if}
    <!-- A numeric term is a valid chat id AND a valid username, and guessing wrong means showing two
         unrelated people's private conversation. Offer the other reading rather than deciding silently. -->
    {#if search.ambiguousUsername}
      <p class="m-0 rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-sm text-amber-200">
        <strong>{search.term}</strong> is also a username. This is showing chat {search.term} —
        <a href={urlWith({ q: `@${search.term}`, chat: null, spage: null })} class={LINK_CLASS}>
          search for the user instead
        </a>.
      </p>
    {/if}
  </div>

  <ul class="m-0 flex list-none flex-col p-0 text-sm lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
    {#each search.chats as chat, i (chat.chatId)}
      {@const open = chat.chatId === chatId}
      <li
        bind:this={rows[i]}
        class="relative border-b border-l-2 border-b-dark-4 px-3 py-2.5 transition-colors hover:bg-dark-5 {open
          ? 'border-l-blue-500 bg-dark-5'
          : i === highlighted
            ? 'border-l-dark-2'
            : 'border-l-transparent'}"
      >
        <div class="flex flex-wrap items-baseline gap-x-2 text-xs">
          <!-- Stretched over the row, so the whole row opens the chat; the names stay their own links
               by sitting above it. -->
          <a
            href={href(chat)}
            aria-current={open ? 'true' : undefined}
            data-sveltekit-noscroll
            class="{LINK_CLASS} font-medium after:absolute after:inset-0 focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-blue-4"
          >
            chat {chat.chatId}
          </a>
          {#if chat.ownerId}
            <a href={userLookupUrl(chat.ownerId)} class="relative z-10 {LINK_CLASS}">
              {chat.owner ?? `#${chat.ownerId}`}
            </a>
          {:else}
            <span class="text-dark-2">no owner</span>
          {/if}
          {#if chat.ownerBannedAt}<Badge variant="destructive">owner banned</Badge>{/if}
          <span class="ml-auto text-dark-2">{num(chat.messages)} msgs</span>
        </div>
        {#if chat.members.length}
          <p class="m-0 mt-0.5 line-clamp-1 text-xs text-dark-2">
            with {#each chat.members as m, mi (m.userId)}{mi > 0 ? ', ' : ''}<a
                href={userLookupUrl(m.userId)}
                class="relative z-10 {LINK_CLASS}">{m.username ?? `#${m.userId}`}</a
              >{/each}
          </p>
        {/if}
        {#if chat.excerpt}
          <p
            class="m-0 mt-1.5 line-clamp-2 border-l-2 pl-2 wrap-break-word text-dark-0 {chat.excerpt.deleted
              ? 'border-red-500/60'
              : 'border-dark-4'}"
          >
            <span class="text-xs text-dark-2">{chat.excerpt.username ?? `#${chat.excerpt.userId}`}:</span>
            {chat.excerpt.content}
          </p>
        {/if}
        <div class="mt-1 flex flex-wrap items-baseline gap-x-2 text-xs text-dark-2">
          {#if chat.hits !== null}
            <span class="text-amber-200/90">
              {num(chat.hits)}
              {search.mode === 'user'
                ? `${chat.hits === 1 ? 'message' : 'messages'} from ${search.term.replace(/^@/, '')}`
                : `matching ${chat.hits === 1 ? 'message' : 'messages'} in ${search.contentSearchDays} days`}
            </span>
          {/if}
          {#if chat.excerpt?.deleted}<Badge variant="destructive">deleted</Badge>{/if}
          <span class="ml-auto">{dateTime(chat.excerpt?.createdAt ?? chat.lastAt)}</span>
        </div>
      </li>
    {:else}
      <li class="px-3 py-8 text-center text-dark-2">
        {search.page > 1 ? 'No more chats.' : 'No chats matched.'}{#if search.mode === 'content'}
          Message text is searched over the last {search.contentSearchDays} days only, so an older
          conversation would not appear here.{/if}
      </li>
    {/each}
  </ul>

  {#if search.chats.length || search.page > 1}
    <footer
      class="flex shrink-0 items-center justify-between gap-3 border-t border-dark-4 px-3 py-2 text-xs text-dark-2"
      data-sveltekit-noscroll
    >
      <span class="tabular-nums">
        {#if search.chats.length}
          {num(firstShown)} to {num(firstShown + search.chats.length - 1)}{search.total !== null
            ? ` of ${num(search.total)}`
            : ''}
        {:else}
          Page {search.page}
        {/if}
      </span>
      <span class="flex gap-2.5">
        {#if search.page > 1}
          <a href={pageHref(search.page - 1)} class={LINK_CLASS}>Prev</a>
        {:else}
          <span aria-disabled="true">Prev</span>
        {/if}
        {#if search.hasMore}
          <a href={pageHref(search.page + 1)} class={LINK_CLASS}>Next</a>
        {:else}
          <span aria-disabled="true">Next</span>
        {/if}
      </span>
    </footer>
  {/if}
</section>
