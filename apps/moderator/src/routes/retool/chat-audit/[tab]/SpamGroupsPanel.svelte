<script lang="ts">
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import ShowMoreButton from '$lib/components/ShowMoreButton.svelte';
  import { LINK_CLASS, num } from '$lib/format';
  import { userLookupUrl } from '$lib/entity-url';
  import type { ChatInsights } from './chat-insights';

  let { spam }: { spam: ChatInsights['spam'] } = $props();

  const SHOWN = 10;
  let expanded = $state(false);
  // Private messages: the count and the sender make a row actionable, the body is evidence a
  // moderator should have to ask for.
  let showBodies = $state(false);
  const visible = $derived(!spam ? [] : expanded ? spam.groups : spam.groups.slice(0, SHOWN));
</script>

<section class="mb-4 rounded-xl border border-dark-4 bg-dark-6 p-5">
  <div class="mb-1 flex flex-wrap items-baseline justify-between gap-x-3">
    <h3 class="text-sm font-semibold text-white">
      Repeated messages{#if spam}&nbsp;({num(spam.groups.length)}{spam.truncated ? '+' : ''}){/if}
    </h3>
    {#if spam?.groups.length}
      <button type="button" class="text-xs {LINK_CLASS}" onclick={() => (showBodies = !showBodies)}>
        {showBodies ? 'Hide message text' : 'Show message text'}
      </button>
    {/if}
  </div>
  <p class="mb-3 text-xs text-dark-2">
    The same text sent by one account into several chats is what DM spam looks like.{#if spam}
      Last {spam.days} days.{/if}
  </p>

  {#if !spam}
    <p class="text-sm text-red-300">Could not load repeated messages.</p>
  {:else if spam.groups.length === 0}
    <p class="text-sm text-dark-2">Nobody sent the same text into multiple chats.</p>
  {:else}
    <ul class="space-y-2 text-sm">
      {#each visible as g (g.key)}
        <li class="min-w-0">
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
      {expanded}
      capped={spam.truncated}
      onToggle={() => (expanded = !expanded)}
    />
  {/if}
</section>
