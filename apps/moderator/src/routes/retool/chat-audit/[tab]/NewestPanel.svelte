<script lang="ts">
  import ShowMoreButton from '$lib/components/ShowMoreButton.svelte';
  import ListFilterBar from '$lib/components/ListFilterBar.svelte';
  import { LINK_CLASS, num } from '$lib/format';
  import MessageMeta from './MessageMeta.svelte';
  import type { NewestMessage } from './chat-insights';

  let { messages }: { messages: NewestMessage[] } = $props();

  const SHOWN = 15;
  let expanded = $state(false);
  // Private messages: the sender and the timing make a row actionable, the body is evidence a
  // moderator should have to ask for.
  let showBodies = $state(false);
  // Retool's textInput2 ("Chat Content Search"). Without it this panel's stated job — watching spam as
  // it happens — has no way to pick the spam string out of the feed, and the bodies are collapsed by
  // default, so there is nothing to scan by eye either. Filtering does not reveal text: a match still
  // needs "Show message text" to read.
  let filters = $state<Record<string, string>>({});
  const matched = $derived(
    filters.term
      ? messages.filter((m) => m.content.toLowerCase().includes(filters.term.toLowerCase()))
      : messages
  );
  const visible = $derived(expanded ? matched : matched.slice(0, SHOWN));
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
    <ListFilterBar
      fields={[{ kind: 'search', key: 'term', label: 'Filter these messages' }]}
      bind:values={filters}
      matched={matched.length}
      total={messages.length}
    />

    {#if matched.length === 0}
      <!-- This filters the loaded page only. Saying so matters: a moderator hunting a spam string
           would otherwise read an empty result as "that string is not on the site", when the
           whole-table search is a different control on the chats tab. -->
      <p class="text-sm text-dark-2">
        No message in this page contains that text. To search every chat, use the
        <a href="/retool/chat-audit/chats" class={LINK_CLASS}>chat search</a>.
      </p>
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
        total={matched.length}
        shown={SHOWN}
        {expanded}
        capped
        onToggle={() => (expanded = !expanded)}
      />
    {/if}
  {/if}
</section>
