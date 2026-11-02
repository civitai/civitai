<script lang="ts">
  import { enhance } from '$app/forms';
  import { invalidateAll } from '$app/navigation';
  import { LINK_CLASS, dateTime } from '$lib/format';
  import { userLookupUrl } from '$lib/entity-url';
  import { FormState } from '$lib/form-state.svelte';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';
  import MessageAsCivitai from '$lib/components/MessageAsCivitai.svelte';
  import TranscriptPanel from '$lib/components/chat-audit/TranscriptPanel.svelte';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  const canAct = $derived(!!data.grants['user.message.asCivitai']);
  const mine = $derived(data.claim !== null && data.claim.moderatorId === data.me);
  const claimForm = new FormState({ onSuccess: null, reload: true });
</script>

<svelte:head><title>Civitai Messages · {data.userId}</title></svelte:head>

<div class="mb-4 flex flex-wrap items-baseline gap-x-3">
  <a href="/messages" class="text-sm {LINK_CLASS}">← Civitai Messages</a>
  <h1 class="text-xl font-semibold text-white">Thread with user {data.userId}</h1>
  <a href={userLookupUrl(data.userId)} class="text-sm {LINK_CLASS}">User Lookup</a>
</div>

{#if data.error}
  <ErrorAlert class="mb-3" message={data.error} />
{:else}
  <section class="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-dark-4 bg-dark-6 p-4">
    {#if data.claim === null}
      <p class="text-sm text-dark-2">Unclaimed.</p>
    {:else if mine}
      <p class="text-sm text-green-300">You hold this thread until {dateTime(data.claim.expiresAt)}.</p>
    {:else}
      <p class="text-sm text-amber-300">
        {data.claim.username ?? `#${data.claim.moderatorId}`} holds this thread until
        {dateTime(data.claim.expiresAt)}.
      </p>
    {/if}
    {#if canAct && data.chatId !== null}
      <form method="POST" action={mine ? '?/release' : '?/claim'} use:enhance={claimForm.enhance}>
        <input type="hidden" name="userId" value={data.userId} />
        <Button type="submit" size="sm" variant="outline" disabled={claimForm.submitting || (!mine && data.claim !== null)}>
          {mine ? 'Release' : 'Claim'}
        </Button>
      </form>
    {/if}
    {#if claimForm.error}<ErrorAlert message={claimForm.error} />{/if}
  </section>

  {#if data.chatId !== null && data.transcript}
    <TranscriptPanel chatId={data.chatId} transcript={data.transcript} members={data.members} />
  {:else}
    <p class="mb-4 text-sm text-dark-2">No thread with this user yet.</p>
  {/if}

  <MessageAsCivitai userId={data.userId} {canAct} action="?/reply" onSent={() => invalidateAll()} />
{/if}
