<script lang="ts">
  import { enhance } from '$app/forms';
  import { invalidateAll } from '$app/navigation';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import * as Select from '@civitai/ui/components/ui/select/index.js';
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

  /** Stands for "leave the status as it is"; posted as an empty `statusAfter`. */
  const LEAVE = 'leave';

  let text = $state('');
  let statusAfter = $state(LEAVE);
  // Seeded once on purpose; a $derived would overwrite the user's pending choice.
  // svelte-ignore state_referenced_locally
  let statusOnly = $state(SETTABLE_STATUSES.some((s) => s === currentStatus) ? String(currentStatus) : '');
  let confirming = $state(false);
  let movedTo = $state<TicketView | null>(null);

  // Reload only while the ticket still belongs to this view; a reload after it left would replace this page with another view's 404.
  function done(what: string, data: Record<string, unknown> | undefined) {
    const moved = data?.moved;
    if (moved === 'moderation' || moved === 'support') movedTo = moved;
    else void invalidateAll();
    if (typeof data?.warning !== 'string') toast.success(what);
  }

  const reply = new FormState({
    onSuccess: (data) => {
      text = '';
      statusAfter = LEAVE;
      done('Reply sent', data);
    },
    onSettled: () => (confirming = false),
  });
  // reset: false, because a form reset would snap the pre-filled select to its first option.
  const status = new FormState({
    onSuccess: (data) => done('Status changed', data),
    reset: false,
  });

  const afterLabel = $derived(
    statusAfter === LEAVE ? `Leave as ${statusLabel(currentStatus)}` : statusLabel(Number(statusAfter))
  );
</script>

<section class="mt-4 rounded-xl border border-dark-4 bg-dark-6 p-5">
  <h2 class="mb-3 text-white">Reply</h2>

  {#if movedTo}
    <p class="text-sm">
      Done — this ticket now belongs to the {movedTo} view, so it no longer opens here.
      <a class={LINK_CLASS} href="/tickets/{view}">Back to the {view} list</a>
    </p>
    {@const warning = reply.warning ?? status.warning}
    {#if warning}<p class="mt-2 text-sm text-amber-400">{warning}</p>{/if}
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
          <input type="hidden" name="statusAfter" value={statusAfter === LEAVE ? '' : statusAfter} />
          <Select.Root type="single" bind:value={statusAfter} disabled={reply.submitting}>
            <Select.Trigger class="w-56">{afterLabel}</Select.Trigger>
            <Select.Content>
              <Select.Item value={LEAVE}>Leave as {statusLabel(currentStatus)}</Select.Item>
              {#each SETTABLE_STATUSES as s (s)}
                <Select.Item value={String(s)}>{statusLabel(s)}</Select.Item>
              {/each}
            </Select.Content>
          </Select.Root>
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
        <Select.Root
          type="single"
          name="status"
          bind:value={statusOnly}
          disabled={status.submitting}
        >
          <Select.Trigger class="w-56">
            {statusOnly ? statusLabel(Number(statusOnly)) : 'Choose a status'}
          </Select.Trigger>
          <Select.Content>
            {#each SETTABLE_STATUSES as s (s)}
              <Select.Item value={String(s)}>{statusLabel(s)}</Select.Item>
            {/each}
          </Select.Content>
        </Select.Root>
      </label>
      <Button
        type="submit"
        size="sm"
        variant="outline"
        disabled={status.submitting || !statusOnly}
      >
        Set status
      </Button>
      {#if status.error}<p class="w-full text-sm text-red-400">{status.error}</p>{/if}
      {#if status.warning}<p class="w-full text-sm text-amber-400">{status.warning}</p>{/if}
    </form>
  {/if}
</section>
