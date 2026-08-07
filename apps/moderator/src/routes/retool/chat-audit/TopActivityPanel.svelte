<script lang="ts">
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import {
    ToggleGroup,
    ToggleGroupItem,
  } from '@civitai/ui/components/ui/toggle-group/index.js';
  import ShowMoreButton from '$lib/components/ShowMoreButton.svelte';
  import { LINK_CLASS, num } from '$lib/format';
  import { userLookupUrl } from '$lib/entity-url';
  import { chatUrl } from './url';
  import type { ChatInsights } from './chat-insights';

  let { stats }: { stats: ChatInsights['stats'] } = $props();

  const SHOWN = 10;
  let expanded = $state(false);
  // All time finds the heaviest accounts; 24h finds who is spamming right now.
  let window24h = $state(false);

  const allChatters = $derived(
    !stats ? [] : window24h ? stats.topChatters24h : stats.topChatters
  );
  const chatters = $derived(expanded ? allChatters : allChatters.slice(0, SHOWN));
  const chattersCapped = $derived(
    !stats ? false : window24h ? stats.chattersCapped24h : stats.chattersCapped
  );
  const topChats = $derived(!stats ? [] : window24h ? stats.topChats24h : stats.topChats);
  const totals = $derived(
    !stats
      ? []
      : ([
          ['Chats', stats.chats],
          ['Chats (24h)', stats.chats24h],
          ['Messages', stats.messages],
          ['Messages (24h)', stats.messages24h],
        ] as [string, number][])
  );
</script>

<section class="mb-4 rounded-xl border border-dark-4 bg-dark-6 p-5">
  <div class="mb-4 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
    <h3 class="text-sm font-semibold text-white">Platform activity</h3>
    <ToggleGroup
      type="single"
      value={window24h ? '24h' : 'all'}
      onValueChange={(v) => v && (window24h = v === '24h')}
      size="sm"
    >
      <ToggleGroupItem value="all" aria-label="All time">all time</ToggleGroupItem>
      <ToggleGroupItem value="24h" aria-label="Last 24 hours">last 24h</ToggleGroupItem>
    </ToggleGroup>
  </div>

  {#if !stats}
    <p class="text-sm text-red-300">Could not load chat activity.</p>
  {:else}
    <div class="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
      {#each totals as [label, value] (label)}
        <div>
          <div class="text-xl font-semibold tabular-nums text-white">{num(value)}</div>
          <div class="text-xs text-dark-2">{label}</div>
        </div>
      {/each}
    </div>

    <div class="grid gap-5 lg:grid-cols-2">
      <div>
        <h4 class="mb-2 text-xs tracking-wide text-dark-2 uppercase">
          Most messages sent ({num(allChatters.length)}{chattersCapped ? '+' : ''})
        </h4>
        {#if allChatters.length === 0}
          <p class="text-sm text-dark-2">No activity.</p>
        {:else}
          <ul class="space-y-1 text-sm">
            {#each chatters as c (c.userId)}
              <li class="flex flex-wrap items-baseline gap-x-2">
                <span class="tabular-nums text-dark-0">{num(c.messages)}</span>
                <a href={userLookupUrl(c.userId)} class={LINK_CLASS}>
                  {c.username ?? `#${c.userId}`}
                </a>
                {#if c.bannedAt}<Badge variant="destructive">banned</Badge>{/if}
              </li>
            {/each}
          </ul>
          <ShowMoreButton
            total={allChatters.length}
            shown={SHOWN}
            {expanded}
            capped={chattersCapped}
            onToggle={() => (expanded = !expanded)}
          />
        {/if}
      </div>

      <div>
        <h4 class="mb-2 text-xs tracking-wide text-dark-2 uppercase">Busiest chats</h4>
        {#if topChats.length === 0}
          <p class="text-sm text-dark-2">No activity.</p>
        {:else}
          <ul class="space-y-1 text-sm">
            {#each topChats as c (c.chatId)}
              <li class="flex flex-wrap items-baseline gap-x-2">
                <span class="tabular-nums text-dark-0">{num(c.messages)}</span>
                <a href={chatUrl(c.chatId)} class={LINK_CLASS}>chat {c.chatId}</a>
              </li>
            {/each}
          </ul>
        {/if}
      </div>
    </div>
  {/if}
</section>
