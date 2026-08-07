<script lang="ts">
  import { dateTime, num } from '$lib/format';
  import type { Signals } from './signals';

  let { signals }: { signals: Promise<Signals> | null } = $props();
</script>

<section class="mb-4 rounded-xl border border-dark-4 bg-dark-6 p-5">
  <h3 class="mb-1 text-sm font-semibold text-white">Chat (DMs)</h3>
  <p class="mb-3 text-xs text-dark-2">
    Whether this account has spoken with a moderator. Transcripts live in Chat Audit — this is the
    prior-context warning, not a chat browser.
  </p>

  {#await signals}
    <p class="text-sm text-dark-2">Checking…</p>
  {:then result}
    {#if result}
      {#if result.modContact.chats === 0}
        <p class="text-sm text-dark-2">No moderator contact on record.</p>
      {:else}
        <div class="rounded-md border border-blue-500/30 bg-blue-500/10 p-2 text-sm text-blue-200">
          This account has spoken with a moderator in {num(result.modContact.chats)}
          {result.modContact.chats === 1 ? 'chat' : 'chats'} — most recently {dateTime(
            result.modContact.lastAt
          )}. Check for prior context before acting.
        </div>
      {/if}
    {/if}
  {:catch}
    <p class="text-sm text-red-300">Could not check moderator contact.</p>
  {/await}
</section>
