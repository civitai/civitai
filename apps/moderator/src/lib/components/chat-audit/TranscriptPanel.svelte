<script lang="ts">
  import { page } from '$app/state';
  import { TRANSCRIPT_AFTER, TRANSCRIPT_AROUND, TRANSCRIPT_BEFORE } from '$lib/chat-transcript-cursor';
  import { urlWith } from '$lib/url';
  import { LINK_CLASS, num } from '$lib/format';
  import { userLookupUrl } from '$lib/entity-url';
  import MessageMeta from './MessageMeta.svelte';
  import MessageEdits from './MessageEdits.svelte';
  import MemberBadges from './MemberBadges.svelte';
  import ListFilterBar from '$lib/components/ListFilterBar.svelte';
  import type { ChatMemberRow, getTranscript } from '$lib/server/chat-audit.service';

  // One chat's transcript and members — Chat Audit's open chat, and the chat report queue's evidence.
  let {
    chatId,
    transcript,
    members,
    reportedIds = [],
    reporterIds = [],
  }: {
    chatId: number;
    transcript: Awaited<ReturnType<typeof getTranscript>>;
    members: ChatMemberRow[];
    /** The report queue's: the member a report is about, marked on their messages and in the list. */
    reportedIds?: number[];
    /** The report queue's: who filed the open reports. */
    reporterIds?: number[];
  } = $props();
  const reported = $derived(new Set(reportedIds));
  const reporters = $derived(new Set(reporterIds));

  const pageHref = (before: number | null, after: number | null) =>
    urlWith(page.url, {
      [TRANSCRIPT_BEFORE]: before,
      [TRANSCRIPT_AFTER]: after,
      [TRANSCRIPT_AROUND]: null,
    });
  const first = $derived(transcript.rows[0]);
  const last = $derived(transcript.rows.at(-1));
  const paged = $derived(
    page.url.searchParams.has(TRANSCRIPT_BEFORE) || page.url.searchParams.has(TRANSCRIPT_AFTER)
  );

  // Retool's select2 (participant) and textInput1 (content), both client-side over the loaded
  // page. In a 300-message chat, "what did THIS person say" and "find the message containing X"
  // are the two questions a moderator opens a transcript to answer.
  const senders = $derived(
    [...new Set(transcript.rows.map((m) => m.username).filter((u): u is string => !!u))].sort()
  );
  let filters = $state<Record<string, string>>({});
  const shown = $derived(
    transcript.rows.filter(
      (m) =>
        (!filters.sender || m.username === filters.sender) &&
        (!filters.term || (m.content ?? '').toLowerCase().includes(filters.term.toLowerCase()))
    )
  );
</script>

<section class="mb-4 grid gap-4 lg:grid-cols-[2fr_1fr]">
  <div class="min-w-0 rounded-xl border border-dark-4 bg-dark-6 p-5">
    <h3 class="mb-1 text-sm font-semibold text-white">
      Transcript — chat {chatId} ({num(transcript.rows.length)}{transcript.hasOlder ||
      transcript.hasNewer
        ? ' on this page'
        : ''})
    </h3>
    <p class="mb-3 text-xs text-dark-2">
      Private messages, oldest first. System join lines are excluded. Deleted messages are shown —
      they are hidden from both participants, which is usually why a report was filed about one.
    </p>

    {#snippet pager(top: boolean)}
      {#if transcript.hasOlder || transcript.hasNewer || paged}
        <nav
          aria-label={top ? 'Transcript pages' : 'Transcript pages, bottom'}
          class="my-2 flex flex-wrap items-center gap-3 text-xs"
          data-sveltekit-noscroll
        >
          {#if transcript.hasOlder && first}
            <a href={pageHref(first.id, null)} class={LINK_CLASS}>← Older messages</a>
          {/if}
          {#if transcript.hasNewer && last}
            <a href={pageHref(null, last.id)} class={LINK_CLASS}>Newer messages →</a>
          {/if}
          {#if paged}
            <a href={pageHref(null, null)} class={LINK_CLASS}>Latest</a>
          {/if}
          {#if top && transcript.rows.length}
            <span class="text-dark-2">The filters below search this page only.</span>
          {/if}
        </nav>
      {/if}
    {/snippet}

    {@render pager(true)}

    {#if transcript.rows.length === 0}
      <p class="text-sm text-dark-2">
        {paged ? 'No messages on this page.' : 'No messages in this chat.'}
      </p>
    {:else}
      <ListFilterBar
        fields={[
          { kind: 'select', key: 'sender', label: 'From', options: senders.map((s) => [s, s]) },
          { kind: 'search', key: 'term', label: 'Search messages' },
        ]}
        bind:values={filters}
        matched={shown.length}
        total={transcript.rows.length}
      />

      {#if shown.length === 0}
        <p class="text-sm text-dark-2">No messages match these filters.</p>
      {/if}

      <ul class="space-y-2 text-sm">
        {#each shown as m (m.id)}
          <li
            class={m.deletedAt
              ? 'rounded-md border-l-2 border-red-500/50 pl-2'
              : reported.has(m.userId)
              ? 'rounded-md border-l-2 border-amber-400/60 pl-2'
              : ''}
          >
            <MessageMeta {...m} reported={reported.has(m.userId)} />
            <p class="min-w-0 wrap-break-word whitespace-pre-wrap text-dark-0">{m.content}</p>

            {#if m.editedAt}
              <MessageEdits edits={transcript.edits[m.id]} partial={transcript.editsPartial} />
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
    {@render pager(false)}
  </div>

  <div class="min-w-0 rounded-xl border border-dark-4 bg-dark-6 p-5">
    <h3 class="mb-3 text-sm font-semibold text-white">Members ({members.length})</h3>
    {#if members.length === 0}
      <p class="text-sm text-dark-2">No members recorded.</p>
    {:else}
      <ul class="space-y-1.5 text-sm">
        {#each members as m (m.userId)}
          <li class="flex flex-wrap items-baseline gap-x-2">
            <a href={userLookupUrl(m.userId)} class={LINK_CLASS}>
              {m.username ?? `#${m.userId}`}
            </a>
            <MemberBadges
              member={m}
              reported={reported.has(m.userId)}
              reporter={reporters.has(m.userId)}
            />
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</section>
