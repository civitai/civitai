<script lang="ts">
  import ShowMoreButton from '$lib/components/ShowMoreButton.svelte';
  import { LINK_CLASS, num } from '$lib/format';
  import MessageMeta from './MessageMeta.svelte';
  import type { NewestMessage } from './chat-insights';

  let { messages }: { messages: NewestMessage[] } = $props();

  const SHOWN = 15;
  let expanded = $state(false);
  // Private messages: the sender and the timing make a row actionable, the body is evidence a
  // moderator should have to ask for.
  let showBodies = $state(false);
  const visible = $derived(expanded ? messages : messages.slice(0, SHOWN));
</script>

<section class="mb-4 rounded-xl border border-dark-4 bg-dark-6 p-5">
  <div class="mb-1 flex flex-wrap items-baseline justify-between gap-x-3">
    <h3 class="text-sm font-semibold text-white">Newest messages ({num(messages.length)})</h3>
    {#if messages.length}
      <button type="button" class="text-xs {LINK_CLASS}" onclick={() => (showBodies = !showBodies)}>
        {showBodies ? 'Hide message text' : 'Show message text'}
      </button>
    {/if}
  </div>
  <p class="mb-3 text-xs text-dark-2">
    The most recent private messages across the site, newest first — for watching spam as it happens.
  </p>

  {#if messages.length === 0}
    <p class="text-sm text-dark-2">No recent messages.</p>
  {:else}
    <ul class="space-y-1.5 text-sm">
      {#each visible as m (m.id)}
        <li class="min-w-0">
          <MessageMeta {...m} />
          {#if showBodies}
            <p class="line-clamp-2 wrap-break-word text-dark-0">{m.content}</p>
          {/if}
        </li>
      {/each}
    </ul>
    <ShowMoreButton
      total={messages.length}
      shown={SHOWN}
      {expanded}
      capped
      onToggle={() => (expanded = !expanded)}
    />
  {/if}
</section>
