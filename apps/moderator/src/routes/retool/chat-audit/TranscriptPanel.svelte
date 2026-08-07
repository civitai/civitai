<script lang="ts">
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { LINK_CLASS, dateTime, num } from '$lib/format';
  import { userLookupUrl } from '$lib/entity-url';
  import MessageMeta from './MessageMeta.svelte';
  import type { PageData } from './$types';

  type Result = NonNullable<PageData['transcript']>;
  type Members = NonNullable<PageData['members']>;

  let {
    chatId,
    transcript,
    members,
  }: { chatId: number; transcript: Result; members: Members } = $props();
</script>

<section class="mb-4 grid gap-4 lg:grid-cols-[2fr_1fr]">
  <div class="min-w-0 rounded-xl border border-dark-4 bg-dark-6 p-5">
    <h3 class="mb-1 text-sm font-semibold text-white">
      Transcript — chat {chatId} ({num(transcript.rows.length)}{transcript.truncated ? '+' : ''})
    </h3>
    <p class="mb-3 text-xs text-dark-2">
      Private messages, oldest first. System join lines are excluded.
    </p>

    {#if transcript.truncated}
      <p class="mb-2 text-xs text-amber-300">
        Capped — this chat has more messages than are shown, and the oldest were dropped.
      </p>
    {/if}

    {#if transcript.rows.length === 0}
      <p class="text-sm text-dark-2">No messages in this chat.</p>
    {:else}
      <ul class="space-y-2 text-sm">
        {#each transcript.rows as m (m.id)}
          <li>
            <MessageMeta {...m} />
            <p class="min-w-0 wrap-break-word whitespace-pre-wrap text-dark-0">{m.content}</p>
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
