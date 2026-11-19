<script lang="ts">
  import { navigating, page } from '$app/state';
  import { afterNavigate } from '$app/navigation';
  import { cn } from '@civitai/ui/utils.js';
  import LookupSearch from '$lib/components/LookupSearch.svelte';
  import type { LayoutData } from './$types';
  import { TABS, TAB_LABELS } from '../tabs';
  import { tabUrl } from '../url';
  import {
    TRANSCRIPT_AFTER,
    TRANSCRIPT_AROUND,
    TRANSCRIPT_BEFORE,
  } from '$lib/chat-transcript-cursor';
  import ChatPane from './ChatPane.svelte';

  let { data, children }: { data: LayoutData; children: import('svelte').Snippet } = $props();

  const current = $derived(page.params.tab);
  // The list's own load; a text search takes seconds a page.
  const listing = $derived.by(() => {
    const next = navigating.to?.url;
    if (!next || next.pathname !== page.url.pathname) return false;
    return ['q', 'spage', 'rpage', 'rstatus'].some(
      (k) => next.searchParams.get(k) !== page.url.searchParams.get(k)
    );
  });

  // A transcript load is several queries; name what is on its way rather than leave the last page up.
  const PANE_KEYS = ['chat', TRANSCRIPT_BEFORE, TRANSCRIPT_AFTER, TRANSCRIPT_AROUND];
  const opening = $derived.by(() => {
    const next = navigating.to?.url.searchParams;
    if (!next?.get('chat')) return null;
    const now = page.url.searchParams;
    if (next.get('chat') !== now.get('chat')) return `Opening chat ${next.get('chat')}…`;
    return PANE_KEYS.some((k) => next.get(k) !== now.get(k)) ? 'Loading messages…' : null;
  });

  // The list scrolls on its own from `lg`, and SvelteKit resets only the window: a new tab or search
  // starts at the top, while opening a chat from the list keeps the list where it was.
  let list = $state<HTMLElement>();
  afterNavigate(({ from, to }) => {
    if (!from || !to) return;
    const moved =
      from.url.pathname !== to.url.pathname ||
      from.url.searchParams.get('q') !== to.url.searchParams.get('q') ||
      from.url.searchParams.get('spage') !== to.url.searchParams.get('spage');
    if (moved) list?.scrollTo(0, 0);
  });
</script>

<!-- `lg` not `md`, as on User Lookup: the app sidebar is 16rem of flow width from 768px up. -->
<div data-two-pane class="flex flex-col lg:grid lg:h-svh lg:grid-cols-[26rem_1fr]">
  <aside data-pane class="flex min-w-0 flex-col border-dark-4 lg:min-h-0 lg:border-r">
    <div class="shrink-0 border-b border-dark-4 px-4 pt-2.5 pb-4">
      <div class="flex items-baseline justify-between gap-3 pl-10 md:pl-0">
        <h1 class="m-0 text-xl font-semibold text-white">Chat Audit</h1>
        <a href="/retool/chat-audit-log" class="text-[11px] text-dark-2 hover:underline">
          Opening a chat is logged
        </a>
      </div>
      <p class="m-0 mt-0.5 pl-10 text-[13px] text-dark-2 md:pl-0">
        Private conversations. Read them because an investigation needs it.
      </p>
    </div>

    <nav
      aria-label="Chat Audit lists"
      class="flex shrink-0 border-b border-dark-4 px-2"
    >
      {#each TABS as tab (tab)}
        <a
          href={tabUrl(tab)}
          aria-current={current === tab ? 'page' : undefined}
          class={cn(
            '-mb-px border-b-2 px-3 py-2 text-sm whitespace-nowrap',
            current === tab
              ? 'border-blue-500 text-white'
              : 'border-transparent text-dark-2 hover:text-dark-0'
          )}
        >
          {TAB_LABELS[tab]}
        </a>
      {/each}
    </nav>

    {#if current === 'chats'}
      <div class="shrink-0 border-b border-dark-4 px-3 py-3">
        <LookupSearch
          q={data.q}
          placeholder="chat id, username, or message text"
          path="/retool/chat-audit/chats"
          class="mb-0"
        />
      </div>
    {/if}

    <div
      bind:this={list}
      aria-busy={listing}
      class="flex min-h-0 flex-1 flex-col transition-opacity lg:overflow-y-auto {listing
        ? 'pointer-events-none opacity-50'
        : ''}"
    >
      {@render children()}
    </div>
  </aside>

  <!-- `relative`: the pane's "Jump to latest" sits in its corner. -->
  <div data-pane class="relative flex min-w-0 flex-col lg:min-h-0">
    {#if opening}
      <div
        role="status"
        class="absolute inset-0 z-20 flex items-start justify-center bg-dark-7/70 pt-24"
      >
        <p class="text-sm text-dark-0">{opening}</p>
      </div>
    {/if}
    {#if data.chat?.missing}
      <p class="m-6 text-sm text-dark-2">
        No chat <code>{data.chat.chatId}</code> exists. A real conversation with no messages would still
        list its members, so this id was never a chat.
      </p>
    {:else if data.chat}
      {#key data.chat.chatId}
        <ChatPane chat={data.chat} highlight={data.highlight} />
      {/key}
    {:else}
      <p class="m-6 text-sm text-dark-2">
        Open a chat from the list to read it here.
      </p>
    {/if}
  </div>
</div>
