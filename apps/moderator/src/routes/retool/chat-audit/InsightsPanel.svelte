<script lang="ts">
  import { browser } from '$app/environment';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import ShowMoreButton from '$lib/components/ShowMoreButton.svelte';
  import { LINK_CLASS, num } from '$lib/format';
  import { userLookupUrl } from '$lib/entity-url';
  import { fetchChatInsights } from './chat-insights';

  const SHOWN = 10;
  let expandedSpam = $state(false);
  let expandedChatters = $state(false);
  // These are private messages. The count and the sender make a row actionable; the body is evidence a
  // moderator should have to ask for, matching the blocked-prompt decision on User Lookup.
  let showBodies = $state(false);

  // Off the page load: every query behind this scans the 4.2M-row ChatMessage table.
  const insights = $derived(browser ? fetchChatInsights() : null);
</script>

{#snippet loading()}
  <p class="text-sm text-dark-2">Counting chats and looking for repeated messages…</p>
{/snippet}

<section class="mb-4 rounded-xl border border-dark-4 bg-dark-6 p-5">
  <h3 class="mb-1 text-sm font-semibold text-white">Platform activity &amp; repeated messages</h3>
  <p class="mb-3 text-xs text-dark-2">
    The same text sent by one account into several chats is what DM spam looks like.
  </p>

  {#await insights}
    {@render loading()}
  {:then result}
    {#if !result}
      {@render loading()}
    {:else}
      {@const spam = result.spam}
      {@const visibleSpam = expandedSpam ? spam.groups : spam.groups.slice(0, SHOWN)}
      {@const chatters = expandedChatters
        ? result.stats.topChatters
        : result.stats.topChatters.slice(0, SHOWN)}
      {@const totals = [
        ['Chats', result.stats.chats],
        ['Chats (24h)', result.stats.chats24h],
        ['Messages', result.stats.messages],
        ['Messages (24h)', result.stats.messages24h],
      ] as [string, number][]}

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
          <div class="mb-2 flex flex-wrap items-baseline justify-between gap-x-3">
            <h4 class="text-xs tracking-wide text-dark-2 uppercase">
              Repeated messages ({num(spam.groups.length)}{spam.truncated ? '+' : ''})
            </h4>
            {#if spam.groups.length}
              <button
                type="button"
                class="text-xs {LINK_CLASS}"
                onclick={() => (showBodies = !showBodies)}
              >
                {showBodies ? 'Hide message text' : 'Show message text'}
              </button>
            {/if}
          </div>
          <p class="mb-2 text-xs text-dark-2">Last {spam.days} days.</p>

          {#if spam.groups.length === 0}
            <p class="text-sm text-dark-2">Nobody sent the same text into multiple chats.</p>
          {:else}
            <ul class="space-y-2 text-sm">
              {#each visibleSpam as g (g.key)}
                <li>
                  <div class="flex flex-wrap items-baseline gap-x-2">
                    <Badge variant="destructive">{num(g.chats)} chats</Badge>
                    <a href={userLookupUrl(g.userId)} class={LINK_CLASS}>
                      {g.username ?? `#${g.userId}`}
                    </a>
                    {#if g.bannedAt}<Badge variant="secondary">already banned</Badge>{/if}
                  </div>
                  {#if showBodies}
                    <p class="line-clamp-2 wrap-break-word text-dark-0">{g.content}</p>
                  {/if}
                </li>
              {/each}
            </ul>
            <ShowMoreButton
              total={spam.groups.length}
              shown={SHOWN}
              expanded={expandedSpam}
              capped={spam.truncated}
              onToggle={() => (expandedSpam = !expandedSpam)}
            />
          {/if}
        </div>

        <div>
          <h4 class="mb-2 text-xs tracking-wide text-dark-2 uppercase">
            Most messages sent ({num(result.stats.topChatters.length)}{result.stats.chattersCapped
              ? '+'
              : ''})
          </h4>
          {#if result.stats.topChatters.length === 0}
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
              total={result.stats.topChatters.length}
              shown={SHOWN}
              expanded={expandedChatters}
              capped={result.stats.chattersCapped}
              onToggle={() => (expandedChatters = !expandedChatters)}
            />
          {/if}
        </div>
      </div>
    {/if}
  {:catch}
    <p class="text-sm text-red-300">Could not load chat activity.</p>
  {/await}
</section>
