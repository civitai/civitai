<script lang="ts">
  import { enhance } from '$app/forms';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import * as Select from '@civitai/ui/components/ui/select/index.js';
  import { Textarea } from '@civitai/ui/components/ui/textarea/index.js';
  import { FormState } from '$lib/form-state.svelte';
  import { denied } from '$lib/permissions';
  import { SETTABLE_STATUSES, statusLabel } from '$lib/tickets/statuses';

  let {
    ticketId,
    currentStatus,
    canReply,
    ondone,
  }: {
    ticketId: string;
    currentStatus: number;
    /** False renders the controls disabled, with the reason: an absent form reads as the page having none. */
    canReply: boolean;
    /** What a successful write reports: what was done, what the action returned, the status it set. */
    ondone: (what: string, data: Record<string, unknown> | undefined, status: number | null) => void;
  } = $props();

  /** Stands for "leave the status as it is"; posted as an empty `statusAfter`. */
  const LEAVE = 'leave';

  let text = $state('');
  let statusAfter = $state(LEAVE);
  // The status-only choice, until the operator picks one it follows the ticket's own status.
  let picked = $state<string | null>(null);
  const statusOnly = $derived(
    picked ?? (SETTABLE_STATUSES.some((s) => s === currentStatus) ? String(currentStatus) : '')
  );
  let confirming = $state(false);

  const reply = new FormState({
    // Enter in a text field must not send an email; only the confirm button's submit goes through.
    onSubmit: ({ cancel }) => {
      if (!confirming) cancel();
    },
    onSuccess: (data) => {
      const set = statusAfter === LEAVE ? null : Number(statusAfter);
      text = '';
      statusAfter = LEAVE;
      picked = null;
      ondone('Reply sent', data, set);
    },
    onSettled: () => (confirming = false),
  });
  // reset: false, because a form reset would snap the pre-filled select to its first option.
  const status = new FormState({
    onSuccess: (data) => {
      const set = Number(statusOnly);
      picked = null;
      ondone('Status changed', data, set);
    },
    reset: false,
  });

  const afterLabel = $derived(
    statusAfter === LEAVE ? `Leave as ${statusLabel(currentStatus)}` : statusLabel(Number(statusAfter))
  );
  const why = $derived(canReply ? undefined : denied('tickets.reply'));
  const busy = $derived(reply.submitting || status.submitting);
</script>

<div class="flex flex-col gap-2.5">
  <form method="POST" action="?/reply" use:enhance={reply.enhance} class="flex flex-col gap-1.5">
    <input type="hidden" name="ticketId" value={ticketId} />
    <Textarea
      name="body"
      bind:value={text}
      rows={3}
      maxlength={10000}
      placeholder="Plain text. This is emailed to the customer."
      disabled={!canReply || busy}
      title={why}
      class="min-h-0 text-[13px]"
    />
    <input type="hidden" name="statusAfter" value={statusAfter === LEAVE ? '' : statusAfter} />
    <Select.Root type="single" bind:value={statusAfter} disabled={!canReply || busy}>
      <Select.Trigger class="h-8 w-full text-[13px]" aria-label="Status after the reply" title={why}>
        Then: {afterLabel}
      </Select.Trigger>
      <Select.Content>
        <Select.Item value={LEAVE}>Leave as {statusLabel(currentStatus)}</Select.Item>
        {#each SETTABLE_STATUSES as s (s)}
          <Select.Item value={String(s)}>{statusLabel(s)}</Select.Item>
        {/each}
      </Select.Content>
    </Select.Root>
    <!-- The confirm button is the only real submit; it must not unmount itself in its own click
         handler (the submit would never fire) — `confirming` closes from `onSettled` instead. -->
    {#if confirming}
      <div class="flex flex-wrap items-center gap-1.5">
        <span class="w-full text-xs text-red-300">Email this reply to the customer?</span>
        <Button type="submit" size="sm" disabled={busy} data-touch-target>Yes, send</Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy}
          onclick={() => (confirming = false)}
          data-touch-target
        >
          Cancel
        </Button>
      </div>
    {:else}
      <Button
        type="button"
        size="sm"
        disabled={!canReply || busy || !text.trim()}
        title={why}
        onclick={() => (confirming = true)}
        data-touch-target
      >
        Send reply
      </Button>
    {/if}
    {#if reply.error}<p class="m-0 text-xs text-red-300">{reply.error}</p>{/if}
    {#if reply.warning}<p class="m-0 text-xs text-amber-300">{reply.warning}</p>{/if}
  </form>

  <form
    method="POST"
    action="?/status"
    use:enhance={status.enhance}
    class="flex items-center gap-1.5 border-t border-dark-4 pt-2.5"
  >
    <input type="hidden" name="ticketId" value={ticketId} />
    <Select.Root
      type="single"
      name="status"
      bind:value={() => statusOnly, (v) => (picked = v)}
      disabled={!canReply || busy}
    >
      <Select.Trigger class="h-8 min-w-0 flex-1 text-[13px]" aria-label="Status only" title={why}>
        {statusOnly ? statusLabel(Number(statusOnly)) : 'Change status only'}
      </Select.Trigger>
      <Select.Content>
        {#each SETTABLE_STATUSES as s (s)}
          <Select.Item value={String(s)}>{statusLabel(s)}</Select.Item>
        {/each}
      </Select.Content>
    </Select.Root>
    <Button
      type="submit"
      size="sm"
      variant="outline"
      disabled={!canReply || busy || !statusOnly}
      title={why}
    >
      Set status
    </Button>
  </form>
  {#if status.error}<p class="m-0 text-xs text-red-300">{status.error}</p>{/if}
  {#if status.warning}<p class="m-0 text-xs text-amber-300">{status.warning}</p>{/if}
  {#if why}<p class="m-0 text-[11px] text-amber-300">{why}</p>{/if}
</div>
