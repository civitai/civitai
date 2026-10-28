<script lang="ts">
  import { enhance } from '$app/forms';
  import { invalidateAll } from '$app/navigation';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Textarea } from '@civitai/ui/components/ui/textarea/index.js';
  import { toast } from '@civitai/ui/components/ui/sonner/index.js';
  import { FormState } from '$lib/form-state.svelte';
  import { LINK_CLASS } from '$lib/format';
  import type { TicketView } from '$lib/tickets/routing';
  import { SETTABLE_STATUSES, statusLabel } from '$lib/tickets/statuses';

  let {
    ticketId,
    view,
    currentStatus,
  }: { ticketId: string; view: TicketView; currentStatus: number } = $props();

  let text = $state('');
  let confirming = $state(false);
  /** Set when a status change took the ticket out of this view: the page's own load would now 404. */
  let movedTo = $state<TicketView | null>(null);

  // A changed status can route the ticket elsewhere, so the page is reloaded only while it still
  // belongs here — a reload after it left would replace this page with the 404 for another view's ticket.
  function done(what: string, data: Record<string, unknown> | undefined) {
    const moved = data?.moved;
    if (moved === 'moderation' || moved === 'support') movedTo = moved;
    else void invalidateAll();
    if (typeof data?.warning !== 'string') toast.success(what);
  }

  const reply = new FormState({
    onSuccess: (data) => {
      text = '';
      done('Reply sent', data);
    },
    // The confirm step closes when the write settles, success or refusal; the typed text stays on refusal.
    onSettled: () => (confirming = false),
  });
  const status = new FormState({
    onSuccess: (data) => done('Status changed', data),
  });

  const SELECT_CLASS =
    'h-9 rounded-md border border-dark-4 bg-dark-7 px-2 text-sm text-white disabled:opacity-50';
</script>

<section class="mt-4 rounded-xl border border-dark-4 bg-dark-6 p-5">
  <h2 class="mb-3 text-white">Reply</h2>

  {#if movedTo}
    <p class="text-sm">
      Done — this ticket now belongs to the {movedTo} view, so it no longer opens here.
      <a class={LINK_CLASS} href="/tickets/{view}">Back to the {view} list</a>
    </p>
  {:else}
    <form method="POST" action="?/reply" use:enhance={reply.enhance} class="flex flex-col gap-2">
      <Textarea
        name="body"
        bind:value={text}
        rows={6}
        maxlength={10000}
        placeholder="Plain text. This is emailed to the customer."
        disabled={reply.submitting}
      />
      <div class="flex flex-wrap items-center gap-2">
        <label class="flex items-center gap-2 text-sm text-dark-2">
          Then set status
          <select name="statusAfter" class={SELECT_CLASS} disabled={reply.submitting}>
            <option value="">Leave as {statusLabel(currentStatus)}</option>
            {#each SETTABLE_STATUSES as s (s)}
              <option value={s}>{statusLabel(s)}</option>
            {/each}
          </select>
        </label>
        <!-- The confirm button is the only real submit; it must not unmount itself in its own click
             handler (the submit would never fire) — `confirming` closes from `onSettled` instead. -->
        {#if confirming}
          <span class="text-sm text-red-300">Email this reply to the customer?</span>
          <Button type="submit" size="sm" disabled={reply.submitting} data-touch-target>
            Yes, send
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={reply.submitting}
            onclick={() => (confirming = false)}
            data-touch-target
          >
            Cancel
          </Button>
        {:else}
          <Button
            type="button"
            size="sm"
            disabled={reply.submitting || !text.trim()}
            onclick={() => (confirming = true)}
            data-touch-target
          >
            Send reply
          </Button>
        {/if}
      </div>
      {#if reply.error}<p class="text-sm text-red-400">{reply.error}</p>{/if}
      {#if reply.warning}<p class="text-sm text-amber-400">{reply.warning}</p>{/if}
    </form>

    <form
      method="POST"
      action="?/status"
      use:enhance={status.enhance}
      class="mt-5 flex flex-wrap items-center gap-2 border-t border-dark-4 pt-4"
    >
      <label class="flex items-center gap-2 text-sm text-dark-2">
        Change status only
        <select name="status" class={SELECT_CLASS} disabled={status.submitting}>
          {#each SETTABLE_STATUSES as s (s)}
            <option value={s} selected={s === currentStatus}>{statusLabel(s)}</option>
          {/each}
        </select>
      </label>
      <Button type="submit" size="sm" variant="outline" disabled={status.submitting}>
        Set status
      </Button>
      {#if status.error}<p class="w-full text-sm text-red-400">{status.error}</p>{/if}
      {#if status.warning}<p class="w-full text-sm text-amber-400">{status.warning}</p>{/if}
    </form>
  {/if}
</section>
