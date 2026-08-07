<script lang="ts">
  import LookupSearch from '$lib/components/LookupSearch.svelte';
  import type { PageData } from './$types';
  import ChatListPanel from './ChatListPanel.svelte';
  import InsightsPanel from './InsightsPanel.svelte';
  import ReportsPanel from './ReportsPanel.svelte';
  import TranscriptPanel from './TranscriptPanel.svelte';

  let { data }: { data: PageData } = $props();

  // The report queue is the entry point when a moderator arrives without a name; once they are
  // investigating something specific it steps aside to the bottom.
  const investigating = $derived(!!data.q || !!data.chatId);
</script>

<header class="page-header">
  <h1>Chat Audit</h1>
  <p>
    Search direct messages by chat id, username or message text. These are private conversations — read
    them because an investigation needs it.
  </p>
</header>

<LookupSearch q={data.q} placeholder="chat id, username, or message text" />

{#snippet reports()}
  <ReportsPanel
    reports={data.reports}
    total={data.reportsTotal}
    page={data.reportsPage}
    perPage={data.reportsPerPage}
    chatId={data.chatId}
    q={data.q}
  />
{/snippet}

{#if !investigating}
  {@render reports()}
{/if}

{#if data.search}
  {#if data.search.slow}
    <p class="mb-3 text-xs text-amber-300">
      Message-text search reads every message — it is not indexed and takes a few seconds.
    </p>
  {/if}
  <ChatListPanel search={data.search} chatId={data.chatId} />
{/if}

{#if data.chatMissing}
  <section class="mb-4 rounded-xl border border-dark-4 bg-dark-6 p-5">
    <p class="text-sm text-dark-2">
      No chat <code>{data.chatId}</code> exists. A real conversation with no messages would still list
      its members — this id was never a chat.
    </p>
  </section>
{:else if data.chatId && data.transcript && data.members}
  <TranscriptPanel chatId={data.chatId} transcript={data.transcript} members={data.members} />
{/if}

{#if investigating}
  {@render reports()}
{/if}

<InsightsPanel />
