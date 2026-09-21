<script lang="ts">
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { LINK_CLASS, dateTime, num } from '$lib/format';
  import { userLookupUrl } from '$lib/entity-url';
  import MessageMeta from './MessageMeta.svelte';
  import ListFilterBar from '$lib/components/ListFilterBar.svelte';
  import type { PageData } from './$types';

  type Result = NonNullable<PageData['transcript']>;
  type Members = NonNullable<PageData['members']>;

  let {
    chatId,
    transcript,
    members,
  }: { chatId: number; transcript: Result; members: Members } = $props();

  // Retool's select2 (participant) and textInput1 (content), both client-side over the loaded
  // transcript. In a 300-message chat, "what did THIS person say" and "find the message containing X"
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
      Transcript — chat {chatId} ({num(transcript.rows.length)}{transcript.truncated ? '+' : ''})
    </h3>
    <p class="mb-3 text-xs text-dark-2">
      Private messages, oldest first. System join lines are excluded. Deleted messages are shown —
      they are hidden from both participants, which is usually why a report was filed about one.
    </p>

    {#if transcript.truncated}
      <p class="mb-2 text-xs text-amber-300">
        Capped — this chat has more messages than are shown, and the oldest were dropped.
      </p>
    {/if}

    {#if transcript.rows.length === 0}
      <p class="text-sm text-dark-2">No messages in this chat.</p>
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
          {@const edit = transcript.edits?.[m.id]}
          <li class={m.deletedAt ? 'rounded-md border-l-2 border-red-500/50 pl-2' : ''}>
            <MessageMeta {...m} />
            <p class="min-w-0 wrap-break-word whitespace-pre-wrap text-dark-0">{m.content}</p>

            {#if m.editedAt}
              {#if edit}
                <details class="mt-1 text-xs">
                  <summary class="cursor-pointer text-dark-2">
                    Before this edit ({dateTime(edit.at)}{edit.actorRole === 'moderator'
                      ? ', by a moderator'
                      : ''})
                  </summary>
                  <p class="mt-1 wrap-break-word whitespace-pre-wrap text-amber-200/80">
                    {edit.oldValue}{edit.truncated ? '…' : ''}
                  </p>
                </details>
              {:else if transcript.edits === null}
                <p class="mt-1 text-xs text-amber-300">
                  Edited — the audit log could not be read, so the original is unknown here, not
                  absent.
                </p>
              {:else}
                <p class="mt-1 text-xs text-dark-2">
                  Edited — the original was not recorded, so what it said before is unrecoverable.
                </p>
              {/if}
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
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
            {#if m.isOwner}<Badge variant="secondary">owner</Badge>{/if}
            {#if m.bannedAt}<Badge variant="destructive">banned</Badge>{/if}
            {#if m.kickedAt}<Badge variant="destructive">kicked</Badge>{/if}
            {#if m.leftAt}<Badge variant="secondary">left</Badge>{/if}
            <span class="text-xs text-dark-2">{m.status}</span>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</section>
