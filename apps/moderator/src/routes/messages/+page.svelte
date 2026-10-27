<script lang="ts">
  import { LINK_CLASS, dateTime } from '$lib/format';
  import { userLookupUrl } from '$lib/entity-url';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
</script>

<svelte:head><title>Civitai Messages</title></svelte:head>

<div class="mb-4 flex flex-wrap items-baseline justify-between gap-3">
  <div>
    <h1 class="text-xl font-semibold text-white">Civitai Messages</h1>
    <p class="text-sm text-dark-2">
      Threads with the shared Civitai Moderation account. Users can only reply to a thread a moderator
      started. Claim a thread before answering so two people don't reply at once.
    </p>
  </div>
  <nav class="flex gap-3 text-sm">
    <a href="/messages" class={data.awaitingOnly ? 'font-semibold text-white' : LINK_CLASS}>
      Awaiting reply
    </a>
    <a href="/messages?show=all" class={data.awaitingOnly ? LINK_CLASS : 'font-semibold text-white'}>
      All threads
    </a>
  </nav>
</div>

{#if data.error}
  <ErrorAlert class="mb-3" message={data.error} />
{:else if data.threads.length === 0}
  <p class="text-sm text-dark-2">
    {data.awaitingOnly ? 'Nothing is waiting for a reply.' : 'No threads yet.'}
  </p>
{:else}
  <p class="mb-2 text-xs text-dark-2">
    {data.threads.length} thread{data.threads.length === 1 ? '' : 's'}{data.awaitingOnly
      ? ', oldest first'
      : ', newest first'}.
  </p>
  <ul class="divide-y divide-dark-4 rounded-xl border border-dark-4 bg-dark-6">
    {#each data.threads as t (t.chatId)}
      <li class="flex flex-col gap-1 p-4">
        <div class="flex flex-wrap items-baseline gap-x-3">
          <a href={`/messages/${t.userId}`} class="font-medium {LINK_CLASS}">
            {t.username ?? `#${t.userId}`}
          </a>
          <a href={userLookupUrl(t.userId)} class="text-xs {LINK_CLASS}">User Lookup</a>
          <span class="text-xs text-dark-2">{dateTime(t.lastMessageAt)}</span>
          {#if t.lastMessageFromCivitai}
            <Badge variant="secondary">answered</Badge>
          {:else}
            <Badge variant="destructive">awaiting reply</Badge>
          {/if}
          {#if t.claimedBy !== null}
            <Badge variant="secondary">claimed by {t.claimedByUsername ?? `#${t.claimedBy}`}</Badge>
          {/if}
        </div>
        <p class="line-clamp-2 text-sm text-dark-1">{t.lastMessage}</p>
      </li>
    {/each}
  </ul>
{/if}
