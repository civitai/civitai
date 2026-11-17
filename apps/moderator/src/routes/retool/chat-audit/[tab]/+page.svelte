<script lang="ts">
  import { browser } from '$app/environment';
  import type { PageData } from './$types';
  import ChatListPanel from './ChatListPanel.svelte';
  import NewestPanel from './NewestPanel.svelte';
  import ReportsPanel from './ReportsPanel.svelte';
  import SpamGroupsPanel from './SpamGroupsPanel.svelte';
  import TopActivityPanel from './TopActivityPanel.svelte';
  import { fetchChatInsights } from './chat-insights';

  let { data }: { data: PageData } = $props();

  // Every query behind this scans the whole ChatMessage table, so it runs only on the two tabs that
  // display it.
  const wantsInsights = $derived(data.tab === 'stats' || data.tab === 'newest');
  const insights = $derived(browser && wantsInsights ? fetchChatInsights() : null);
</script>

{#if data.tab === 'chats'}
  {#if data.search}
    {#key `${data.q}:${data.search.page}`}
      <ChatListPanel search={data.search} chatId={data.chatId} />
    {/key}
  {:else}
    <p class="p-3 text-sm text-dark-2">
      Search by chat id, username or message text, or open a conversation from Reports.
    </p>
  {/if}
{:else}
  <div class="p-3">
    {#if data.tab === 'reports'}
      <ReportsPanel
        reports={data.reports ?? []}
        total={data.reportsTotal ?? 0}
        statusFilter={data.reportStatusFilter ?? []}
        page={data.reportsPage ?? 1}
        perPage={data.reportsPerPage ?? 20}
        chatId={data.chatId}
      />
    {:else}
      {#await insights}
        <p class="text-sm text-dark-2">Counting chats and looking for repeated messages…</p>
      {:then result}
        {#if result}
          {#if data.tab === 'stats'}
            <TopActivityPanel stats={result.stats} chatId={data.chatId} />
            <SpamGroupsPanel spam={result.spam} />
          {:else if result.newest}
            <NewestPanel messages={result.newest} chatId={data.chatId} />
          {:else}
            <p class="text-sm text-red-300">Could not load recent messages.</p>
          {/if}
        {/if}
      {:catch}
        <p class="text-sm text-red-300">Could not load chat activity.</p>
      {/await}
    {/if}
  </div>
{/if}
