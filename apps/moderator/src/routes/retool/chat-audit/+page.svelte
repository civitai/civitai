<script lang="ts">
  import { browser } from '$app/environment';
  import { cn } from '@civitai/ui/utils.js';
  import LookupSearch from '$lib/components/LookupSearch.svelte';
  import type { PageData } from './$types';
  import ChatListPanel from './ChatListPanel.svelte';
  import NewestPanel from './NewestPanel.svelte';
  import ReportsPanel from './ReportsPanel.svelte';
  import SpamGroupsPanel from './SpamGroupsPanel.svelte';
  import TopActivityPanel from './TopActivityPanel.svelte';
  import TranscriptPanel from './TranscriptPanel.svelte';
  import UserMessagesPanel from './UserMessagesPanel.svelte';
  import { fetchChatInsights } from './chat-insights';
  import { TABS, TAB_LABELS } from './tabs';
  import { tabUrl } from './url';

  let { data }: { data: PageData } = $props();

  // Every query behind this scans the 4.2M-row ChatMessage table, so it runs only for the two tabs
  // that display it — opening a transcript used to trigger all three roll-ups as well.
  const wantsInsights = $derived(data.tab === 'stats' || data.tab === 'newest');
  const insights = $derived(browser && wantsInsights ? fetchChatInsights() : null);
</script>

<header class="page-header">
  <h1>Chat Audit</h1>
  <p>
    Search direct messages by chat id, username or message text. These are private conversations — read
    them because an investigation needs it.
  </p>
</header>

<LookupSearch q={data.q} placeholder="chat id, username, or message text" />

<nav class="mb-4 flex flex-wrap gap-1 border-b border-dark-4">
  {#each TABS as tab (tab)}
    <a
      href={tabUrl(tab)}
      class={cn(
        '-mb-px border-b-2 px-3 py-2 text-sm',
        data.tab === tab
          ? 'border-blue-500 text-white'
          : 'border-transparent text-dark-2 hover:text-dark-0'
      )}
    >
      {TAB_LABELS[tab]}
    </a>
  {/each}
</nav>

{#if data.tab === 'chats'}
  {#if data.search}
    {#if data.search.slow}
      <p class="mb-3 text-xs text-amber-300">
        Message-text search reads every message — it is not indexed and takes a few seconds.
      </p>
    {/if}
    <ChatListPanel search={data.search} chatId={data.chatId} />
  {/if}

  {#if data.userMessages}
    {#key data.q}
      <UserMessagesPanel messages={data.userMessages} />
    {/key}
  {/if}

  {#if data.chatMissing}
    <section class="mb-4 rounded-xl border border-dark-4 bg-dark-6 p-5">
      <p class="text-sm text-dark-2">
        No chat <code>{data.chatId}</code> exists. A real conversation with no messages would still
        list its members — this id was never a chat.
      </p>
    </section>
  {:else if data.chatId && data.transcript && data.members}
    <TranscriptPanel chatId={data.chatId} transcript={data.transcript} members={data.members} />
  {/if}

  {#if !data.q && !data.chatId}
    <section class="rounded-xl border border-dark-4 bg-dark-6 p-5">
      <p class="text-sm text-dark-2">
        Search above by chat id, username or message text, or open a conversation from Chat Reports.
      </p>
    </section>
  {/if}
{:else if data.tab === 'reports'}
  <ReportsPanel
    reports={data.reports}
    total={data.reportsTotal}
    page={data.reportsPage}
    perPage={data.reportsPerPage}
    chatId={data.chatId}
  />
{:else}
  {#await insights}
    <p class="text-sm text-dark-2">Counting chats and looking for repeated messages…</p>
  {:then result}
    {#if result}
      {#if data.tab === 'stats'}
        <TopActivityPanel stats={result.stats} />
        <SpamGroupsPanel spam={result.spam} />
      {:else if result.newest}
        <NewestPanel messages={result.newest} />
      {:else}
        <p class="text-sm text-red-300">Could not load recent messages.</p>
      {/if}
    {/if}
  {:catch}
    <p class="text-sm text-red-300">Could not load chat activity.</p>
  {/await}
{/if}
