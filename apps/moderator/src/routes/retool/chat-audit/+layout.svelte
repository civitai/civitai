<script lang="ts">
  import { page } from '$app/state';
  import { cn } from '@civitai/ui/utils.js';
  import LookupSearch from '$lib/components/LookupSearch.svelte';
  import type { LayoutData } from './$types';
  import { TABS, TAB_LABELS } from './tabs';
  import { tabUrl } from './url';

  let { data, children }: { data: LayoutData; children: import('svelte').Snippet } = $props();

  const current = $derived(page.params.tab);
</script>

<header class="page-header">
  <h1>Chat Audit</h1>
  <p>
    Search direct messages by chat id, username or message text. These are private conversations — read
    them because an investigation needs it.
  </p>
</header>

<LookupSearch
  q={data.q}
  placeholder="chat id, username, or message text"
  path="/retool/chat-audit/chats"
/>

<nav class="mb-4 flex flex-wrap gap-1 border-b border-dark-4">
  {#each TABS as tab (tab)}
    <a
      href={tabUrl(tab)}
      class={cn(
        '-mb-px border-b-2 px-3 py-2 text-sm',
        current === tab
          ? 'border-blue-500 text-white'
          : 'border-transparent text-dark-2 hover:text-dark-0'
      )}
    >
      {TAB_LABELS[tab]}
    </a>
  {/each}
</nav>

{@render children()}
