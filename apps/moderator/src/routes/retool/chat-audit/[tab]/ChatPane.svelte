<script lang="ts">
  import { page } from '$app/state';
  import { afterNavigate } from '$app/navigation';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import {
    TRANSCRIPT_AFTER,
    TRANSCRIPT_AROUND,
    TRANSCRIPT_BEFORE,
  } from '$lib/chat-transcript-cursor';
  import { urlWith } from '$lib/url';
  import { LINK_CLASS, dateTime, num } from '$lib/format';
  import { userLookupUrl } from '$lib/entity-url';
  import { entityReportUrl } from '$lib/entity-report-queues';
  import ListFilterBar from '$lib/components/ListFilterBar.svelte';
  import MessageEdits from '$lib/components/chat-audit/MessageEdits.svelte';
  import MemberBadges from '$lib/components/chat-audit/MemberBadges.svelte';
  import type { LayoutData } from './$types';

  type OpenChat = Extract<NonNullable<LayoutData['chat']>, { missing: false }>;

  let { chat, highlight }: { chat: OpenChat; highlight: LayoutData['highlight'] } = $props();

  // What the search was for, marked on every message it matches: a username search outlines that
  // person's messages, a text search highlights each message holding the term.
  const searchedUser = $derived(
    highlight?.kind === 'user' ? highlight.username.toLowerCase() : null
  );
  const term = $derived(highlight?.kind === 'content' ? highlight.term.toLowerCase() : null);
  const isSearched = (m: { username: string | null }) =>
    !!searchedUser && m.username?.toLowerCase() === searchedUser;
  const hasTerm = (text: string) => !!termPattern && text.search(termPattern) !== -1;

  // The text cut at each occurrence of the term so the hits can be marked. A capturing split rather than
  // indexOf over a lowercased copy: lowercasing can change a string's length and shift the offsets.
  const termPattern = $derived(
    term ? new RegExp(`(${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'giu') : null
  );
  const pieces = (text: string) =>
    termPattern
      ? text
          .split(termPattern)
          .map((t, i) => ({ text: t, hit: i % 2 === 1 }))
          .filter((p) => p.text)
      : [{ text, hit: false }];

  const transcript = $derived(chat.transcript);
  const searchHits = $derived(
    transcript.rows.filter((m) => (term ? hasTerm(m.content) : isSearched(m))).length
  );
  const reported = $derived(new Set(chat.reportedIds));
  const reporters = $derived(new Set(chat.reporterIds));
  const ownerId = $derived(chat.members.find((m) => m.isOwner)?.userId ?? null);

  const pageHref = (cursor: { before?: number; after?: number }) =>
    urlWith(page.url, {
      [TRANSCRIPT_BEFORE]: cursor.before,
      [TRANSCRIPT_AFTER]: cursor.after,
      [TRANSCRIPT_AROUND]: null,
    });
  const first = $derived(transcript.rows[0]);
  const last = $derived(transcript.rows.at(-1));
  const latest = $derived(!transcript.hasNewer);

  // Retool's participant and content filters, over the loaded page: "what did THIS person say" and
  // "find the message containing X" are the two questions a transcript is opened to answer.
  const senders = $derived(
    [...new Set(transcript.rows.map((m) => m.username).filter((u): u is string => !!u))].sort()
  );
  let filters = $state<Record<string, string>>({});
  const shown = $derived(
    transcript.rows.filter(
      (m) =>
        (!filters.sender || m.username === filters.sender) &&
        (!filters.term || m.content.toLowerCase().includes(filters.term.toLowerCase()))
    )
  );

  const day = (d: Date) =>
    d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  // The zone is named because this team reports by screenshot; the UTC equivalent is `dateTime` on hover.
  const time = (d: Date) =>
    d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });

  const days = $derived.by(() => {
    const out: { key: string; rows: typeof shown }[] = [];
    for (const m of shown) {
      const key = day(m.createdAt);
      if (out.at(-1)?.key === key) out.at(-1)!.rows.push(m);
      else out.push({ key, rows: [m] });
    }
    return out;
  });

  // This region scrolls instead of the window, so SvelteKit's own scroll handling does not reach it.
  // A chat opens at its newest message, a match opens centred on the match, and a newer page opens at
  // its top, where it continues from the page before.
  let scroller = $state<HTMLElement>();
  afterNavigate(({ from, to }) => {
    if (!scroller || !to) return;
    const keys = ['chat', TRANSCRIPT_BEFORE, TRANSCRIPT_AFTER, TRANSCRIPT_AROUND];
    if (from && keys.every((k) => from.url.searchParams.get(k) === to.url.searchParams.get(k))) return;
    filters = {};
    const match = chat.around ? scroller.querySelector(`[data-message="${chat.around}"]`) : null;
    if (match) match.scrollIntoView({ block: 'center' });
    else if (to.url.searchParams.has(TRANSCRIPT_AFTER)) scroller.scrollTo(0, 0);
    else scroller.scrollTo(0, scroller.scrollHeight);
  });
</script>

<header class="shrink-0 border-b border-dark-4 px-6 pt-3 pb-3">
  <div class="flex flex-wrap items-baseline gap-x-3">
    <h2 class="m-0 text-base font-semibold text-white">Chat {chat.chatId}</h2>
    {#if chat.position}
      <span class="text-xs text-dark-2">{num(chat.position.total)} messages</span>
    {/if}
    {#if chat.reported}
      <a
        href={entityReportUrl('chat', chat.chatId)}
        class="ml-auto rounded-md border border-amber-500/50 px-2.5 py-1 text-xs text-amber-200 hover:bg-amber-500/10"
      >
        Open in report queue
      </a>
    {/if}
  </div>
  {#if chat.members.length}
    <ul aria-label="Members" class="mt-2 flex flex-wrap gap-1.5">
      {#each chat.members as m (m.userId)}
        <li
          class="inline-flex items-center gap-1.5 rounded-full border border-dark-4 bg-dark-6 py-0.5 pr-2 pl-2.5 text-xs"
        >
          <a href={userLookupUrl(m.userId)} class={LINK_CLASS}>{m.username ?? `#${m.userId}`}</a>
          <MemberBadges
            member={m}
            reported={reported.has(m.userId)}
            reporter={reporters.has(m.userId)}
          />
        </li>
      {/each}
    </ul>
  {:else}
    <p class="mt-2 text-xs text-dark-2">No members recorded.</p>
  {/if}
</header>

<nav
  aria-label="Transcript pages"
  class="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-dark-4 px-6 py-2 text-xs"
  data-sveltekit-noscroll
>
  {#if transcript.hasOlder && first}
    <a href={pageHref({ before: first.id })} class={LINK_CLASS}>← Older</a>
  {:else}
    <span class="text-dark-3">← Older</span>
  {/if}
  {#if chat.position && first}
    <span class="text-dark-0">
      Messages {num(chat.position.before + 1)}–{num(chat.position.before + transcript.rows.length)} of
      {num(chat.position.total)}
    </span>
  {/if}
  {#if transcript.hasNewer && last}
    <a href={pageHref({ after: last.id })} class={LINK_CLASS}>Newer →</a>
    <a href={pageHref({})} class={LINK_CLASS}>Latest</a>
  {:else}
    <span class="text-dark-3">Newer →</span>
  {/if}
  <span class="ml-auto text-dark-2">System messages (join lines, embeds) are left out; deleted messages are shown.</span>
</nav>

<div bind:this={scroller} class="min-h-0 flex-1 overflow-y-auto px-6 pt-3 pb-16">
  <div class="mx-auto max-w-3xl">
    {#if transcript.rows.length === 0}
      <p class="mt-6 text-sm text-dark-2">
        {page.url.searchParams.has(TRANSCRIPT_BEFORE) || page.url.searchParams.has(TRANSCRIPT_AFTER)
          ? 'No messages on this page.'
          : 'No messages in this chat.'}
      </p>
    {:else}
      {#if highlight}
        <p class="mb-2 text-xs text-amber-200/90">
          {#if highlight.kind === 'user'}
            {num(searchHits)} {searchHits === 1 ? 'message' : 'messages'} on this page from
            {highlight.username}, outlined.
          {:else}
            {num(searchHits)} {searchHits === 1 ? 'message' : 'messages'} on this page contain
            “{highlight.term}”.
          {/if}
        </p>
      {/if}
      <ListFilterBar
        fields={[
          { kind: 'select', key: 'sender', label: 'From', options: senders.map((s) => [s, s]) },
          { kind: 'search', key: 'term', label: 'Search this page' },
        ]}
        bind:values={filters}
        matched={shown.length}
        total={transcript.rows.length}
      />
      {#if shown.length === 0}
        <p class="text-sm text-dark-2">No messages on this page match these filters.</p>
      {/if}

      {#each days as d (d.key)}
        <div class="my-4 flex items-center gap-3 text-[11px] text-dark-2">
          <div class="h-px flex-1 bg-dark-4"></div>
          {d.key}
          <div class="h-px flex-1 bg-dark-4"></div>
        </div>
        {#each d.rows as m, i (m.id)}
          {@const mine = m.userId === ownerId}
          {@const startsRun = i === 0 || d.rows[i - 1].userId !== m.userId}
          {@const opened = m.id === chat.around}
          {@const matched = opened || hasTerm(m.content)}
          {@const searched = isSearched(m)}
          {@const modEdited = transcript.edits[m.id]?.some((e) => e.actorRole === 'moderator')}
          <div
            data-message={m.id}
            class="flex {mine ? 'justify-end' : 'justify-start'} {startsRun ? 'mt-3' : 'mt-1'}"
          >
            <div class="max-w-[75%] min-w-0">
              {#if startsRun}
                <div
                  class="mb-0.5 flex flex-wrap items-baseline gap-x-2 text-xs {mine ? 'justify-end' : ''}"
                >
                  <a href={userLookupUrl(m.userId)} class={LINK_CLASS}>{m.username ?? `#${m.userId}`}</a>
                  {#if searched}
                    <span class="rounded border border-amber-400/60 px-1 text-[10.5px] text-amber-200">
                      searched
                    </span>
                  {/if}
                  {#if reported.has(m.userId)}<Badge variant="destructive">reported</Badge>{/if}
                  {#if m.bannedAt}<Badge variant="destructive">banned</Badge>{/if}
                </div>
              {/if}
              <div
                class="rounded-2xl border px-3 py-1.5 text-sm text-dark-0 {m.deletedAt
                  ? 'border-red-500/50 bg-red-500/5'
                  : matched
                    ? 'border-amber-400/70 bg-amber-400/10'
                    : m.sentBy
                      ? 'border-violet-500/40 bg-violet-500/10'
                      : mine
                        ? 'border-sky-500/30 bg-sky-500/10'
                        : 'border-dark-4 bg-dark-5'} {searched
                  ? 'ring-1 ring-amber-400/60'
                  : ''} {opened ? 'ring-2 ring-amber-400' : ''}"
              >
                {#if opened}
                  <div class="text-[10.5px] font-semibold tracking-wide text-amber-300 uppercase">
                    Opened here
                  </div>
                {/if}
                {#if m.sentBy}
                  <div class="text-[11px] text-violet-200">Sent as Civitai Moderation by {m.sentBy}</div>
                {/if}
                {#if m.deletedAt}
                  <div class="text-[11px] text-red-300">
                    Deleted {dateTime(m.deletedAt)}. Hidden from the members, kept for moderation.
                  </div>
                {/if}
                <p class="m-0 min-w-0 wrap-break-word whitespace-pre-wrap">
                  {#each pieces(m.content) as p, pi (pi)}{#if p.hit}<mark
                        class="rounded-sm bg-amber-400/30 px-0.5 text-amber-100">{p.text}</mark
                      >{:else}{p.text}{/if}{/each}
                </p>
                <div
                  class="mt-0.5 flex justify-end gap-2 text-[10.5px] text-dark-2"
                  title={dateTime(m.createdAt)}
                >
                  {#if m.editedAt}
                    <span class={modEdited ? 'text-violet-300' : ''}>
                      {modEdited ? 'edited by a moderator' : 'edited'}
                    </span>
                  {/if}
                  {time(m.createdAt)}
                </div>
                {#if m.editedAt}
                  <MessageEdits edits={transcript.edits[m.id]} partial={transcript.editsPartial} />
                {/if}
              </div>
            </div>
          </div>
        {/each}
      {/each}
    {/if}
  </div>
</div>

{#if !latest}
  <a
    href={pageHref({})}
    data-sveltekit-noscroll
    class="absolute right-6 bottom-5 rounded-full border border-dark-4 bg-dark-5 px-3 py-1.5 text-xs text-dark-0 shadow-lg hover:bg-dark-4"
  >
    Jump to latest ↓
  </a>
{/if}
