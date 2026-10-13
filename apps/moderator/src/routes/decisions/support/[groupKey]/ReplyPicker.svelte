<script lang="ts">
  import { browser } from '$app/environment';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import type { AgentRepliesResult } from '$lib/server/freshdesk.service';
  import { dateTime } from '$lib/format';
  import type { AnswerDraft } from './answer-draft.svelte';

  let { draft, version }: { draft: AnswerDraft; version: string } = $props();

  // A new ticket is a new promise; closing the picker drops it.
  const replies = $derived(
    browser && draft.replyTicket
      ? fetch(
          `/api/decisions/support/${encodeURIComponent(draft.groupKey)}/replies/${encodeURIComponent(
            draft.replyTicket
          )}?version=${encodeURIComponent(version)}`
        ).then(async (r): Promise<AgentRepliesResult> => {
          const body = await r.json().catch(() => null);
          if (!r.ok) throw new Error(body?.message ?? body?.error ?? `HTTP ${r.status}`);
          return body;
        })
      : null
  );
</script>

{#if draft.replyTicket}
  {@const ticketId = draft.replyTicket}
  <section class="mt-4 rounded-xl border border-dark-4 bg-dark-6 p-5" aria-live="polite">
    <div class="mb-2 flex items-center justify-between gap-2">
      <h3 class="text-white">Public agent replies on #{ticketId}</h3>
      <Button size="sm" variant="ghost" onclick={() => (draft.replyTicket = null)}>Close</Button>
    </div>
    <p class="text-dark-2 mb-3 text-sm">
      Choosing one pre-fills the answer below. Nothing is recorded until you record the ruling.
    </p>
    {#await replies}
      <p class="text-dark-2 text-sm">Asking Freshdesk…</p>
    {:then result}
      {#if result?.status === 'found'}
        {#if result.truncated}
          <p class="mb-2 text-sm text-amber-300">
            ⚠ This ticket has more conversations than were read — a later reply may be missing.
          </p>
        {/if}
        <ul class="space-y-3">
          {#each result.replies as reply (reply.conversationId)}
            <li class="rounded border border-dark-4 p-3">
              <p class="text-dark-2 mb-1 text-xs">
                {dateTime(reply.createdAt)}
              </p>
              <!-- Agent-written, but addressed to one customer: rendered as text, never as HTML. -->
              <p class="mb-2 max-h-48 overflow-auto break-words whitespace-pre-wrap text-sm">
                {reply.text}
              </p>
              <Button size="sm" variant="outline" onclick={() => draft.use(ticketId, reply)}>
                Use this reply
              </Button>
            </li>
          {/each}
        </ul>
      {:else if result?.status === 'none'}
        <p class="text-dark-2 text-sm">No public agent reply on this ticket.</p>
      {:else if result?.status === 'unavailable'}
        <p class="text-sm text-red-300" role="alert">Replies unavailable — {result.reason}</p>
      {/if}
    {:catch e}
      <p class="text-sm text-red-300" role="alert">
        Could not load the replies: {e instanceof Error ? e.message : 'unknown error'}
      </p>
    {/await}
  </section>
{/if}
