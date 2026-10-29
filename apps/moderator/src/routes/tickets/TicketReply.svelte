<script lang="ts">
  import { enhance } from '$app/forms';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import * as Select from '@civitai/ui/components/ui/select/index.js';
  import { Textarea } from '@civitai/ui/components/ui/textarea/index.js';
  import { FormState } from '$lib/form-state.svelte';
  import { denied } from '$lib/permissions';
  import { cancelUnlessConfirming } from '$lib/tickets/confirm-guard';
  import { SETTABLE_STATUSES, statusLabel } from '$lib/tickets/statuses';

  let {
    ticketId,
    currentStatus,
    canReply,
    ondone,
    submitting = $bindable(false),
    locked = false,
  }: {
    ticketId: string;
    currentStatus: number;
    /** False renders the controls disabled, with the reason: an absent form reads as the page having none. */
    canReply: boolean;
    ondone: (what: string, data: Record<string, unknown> | undefined, status: number | null) => void;
    /** Out: this form is in flight. */
    submitting?: boolean;
    /** Another write to this ticket is in flight. */
    locked?: boolean;
  } = $props();

  /** Stands for "leave the status as it is"; posted as an empty `statusAfter`. */
  const LEAVE = 'leave';

  let text = $state('');
  let statusAfter = $state(LEAVE);
  let confirming = $state(false);

  const reply = new FormState({
    onSubmit: cancelUnlessConfirming(() => confirming),
    onSuccess: (data) => {
      const set = statusAfter === LEAVE ? null : Number(statusAfter);
      text = '';
      statusAfter = LEAVE;
      ondone('Reply sent', data, set);
    },
    onSettled: () => (confirming = false),
  });

  const afterLabel = $derived(
    statusAfter === LEAVE ? `Leave as ${statusLabel(currentStatus)}` : statusLabel(Number(statusAfter))
  );
  const why = $derived(canReply ? undefined : denied('tickets.reply'));
  $effect(() => {
    submitting = reply.submitting;
  });
  const busy = $derived(reply.submitting || locked);
</script>

<form method="POST" action="?/reply" use:enhance={reply.enhance} class="flex flex-col gap-2">
  <input type="hidden" name="ticketId" value={ticketId} />
  <Textarea
    name="body"
    bind:value={text}
    rows={2}
    maxlength={10000}
    aria-label="Reply to the customer"
    placeholder="Plain text. This is emailed to the customer."
    disabled={!canReply || busy}
    title={why}
    class="max-h-40 min-h-[3.25rem] resize-none text-[13px]"
  />
  <input type="hidden" name="statusAfter" value={statusAfter === LEAVE ? '' : statusAfter} />
  <div class="flex flex-wrap items-center justify-between gap-2">
    <Select.Root type="single" bind:value={statusAfter} disabled={!canReply || busy}>
      <Select.Trigger class="h-7 w-auto text-xs" size="sm" aria-label="Status after the reply" title={why}>
        Then: {afterLabel}
      </Select.Trigger>
      <Select.Content>
        <Select.Item value={LEAVE}>Leave as {statusLabel(currentStatus)}</Select.Item>
        {#each SETTABLE_STATUSES as s (s)}
          <Select.Item value={String(s)}>{statusLabel(s)}</Select.Item>
        {/each}
      </Select.Content>
    </Select.Root>
    {#if confirming}
      <div class="flex flex-wrap items-center gap-1.5">
        <span class="text-xs text-red-300">Email this reply to the customer?</span>
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
  </div>
  {#if reply.error}<p class="m-0 text-xs text-red-300">{reply.error}</p>{/if}
  {#if reply.warning}<p class="m-0 text-xs text-amber-300">{reply.warning}</p>{/if}
  {#if why}<p class="m-0 text-[11px] text-amber-300">{why}</p>{/if}
</form>
