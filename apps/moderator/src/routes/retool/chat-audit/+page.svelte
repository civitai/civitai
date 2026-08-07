<script lang="ts">
  import { untrack } from 'svelte';
  import { goto } from '$app/navigation';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import type { PageData } from './$types';
  import ChatListPanel from './ChatListPanel.svelte';
  import InsightsPanel from './InsightsPanel.svelte';
  import ReportsPanel from './ReportsPanel.svelte';
  import TranscriptPanel from './TranscriptPanel.svelte';

  let { data }: { data: PageData } = $props();

  // Local copy so typing doesn't navigate; re-synced whenever a search lands (incl. back/forward).
  let term = $state(untrack(() => data.q));
  $effect(() => {
    term = data.q;
  });

  // A new search drops the opened transcript — it belongs to the previous result set.
  const search = (e: SubmitEvent) => {
    e.preventDefault();
    const value = term.trim();
    goto(value ? `?q=${encodeURIComponent(value)}` : '?', { keepFocus: true });
  };
</script>

<header class="page-header">
  <h1>Chat Audit</h1>
  <p>
    Search direct messages by chat id, username or message text. These are private conversations —
    read them because an investigation needs it.
  </p>
</header>

<form onsubmit={search} class="mb-6 flex max-w-xl gap-2">
  <Input bind:value={term} placeholder="chat id, username, or message text" class="flex-1" />
  <Button type="submit">Search</Button>
</form>

{#if data.search}
  {#if data.search.slow}
    <p class="mb-3 text-xs text-amber-300">
      Message-text search reads every message — it takes a few seconds and is not indexed.
    </p>
  {/if}
  <ChatListPanel search={data.search} chatId={data.chatId} />
{/if}

<!-- Keyed on the chat: the transcript and member list are wholly per-conversation. -->
{#if data.chatId && data.transcript && data.members}
  {#key data.chatId}
    <TranscriptPanel chatId={data.chatId} transcript={data.transcript} members={data.members} />
  {/key}
{/if}

<ReportsPanel reports={data.reports} chatId={data.chatId} />
<InsightsPanel />
