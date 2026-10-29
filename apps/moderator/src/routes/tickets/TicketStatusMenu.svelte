<script lang="ts">
  import { enhance } from '$app/forms';
  import { tick } from 'svelte';
  import * as DropdownMenu from '@civitai/ui/components/ui/dropdown-menu/index.js';
  import { FormState } from '$lib/form-state.svelte';
  import { denied } from '$lib/permissions';
  import { SETTABLE_STATUSES, statusLabel } from '$lib/tickets/statuses';
  import TicketStatusBadge from './TicketStatusBadge.svelte';

  let {
    ticketId,
    status,
    label,
    canReply,
    ondone,
  }: {
    ticketId: string;
    status: number;
    label: string;
    /** False renders the trigger disabled, with the reason. */
    canReply: boolean;
    ondone: (what: string, data: Record<string, unknown> | undefined, status: number | null) => void;
  } = $props();

  let form = $state<HTMLFormElement>();
  let picked = $state('');

  // reset: false, because a form reset would blank the hidden status field.
  const change = new FormState({
    onSuccess: (data) => ondone('Status changed', data, Number(picked)),
    reset: false,
  });
  const why = $derived(canReply ? undefined : denied('tickets.reply'));

  async function choose(value: string) {
    if (value === String(status)) return;
    picked = value;
    await tick();
    form?.requestSubmit();
  }
</script>

<form bind:this={form} method="POST" action="?/status" use:enhance={change.enhance} class="contents">
  <input type="hidden" name="ticketId" value={ticketId} />
  <input type="hidden" name="status" value={picked} />
  <DropdownMenu.Root>
    <DropdownMenu.Trigger
      disabled={!canReply || change.submitting}
      title={why}
      aria-label="Change status (now {label})"
      class="inline-flex items-center gap-0.5 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
      data-touch-target
    >
      <TicketStatusBadge {status} {label} />
      <span aria-hidden="true" class="text-xs text-dark-2">▾</span>
    </DropdownMenu.Trigger>
    <DropdownMenu.Content align="start">
      <DropdownMenu.RadioGroup value={String(status)} onValueChange={choose}>
        {#each SETTABLE_STATUSES as s (s)}
          <DropdownMenu.RadioItem value={String(s)}>{statusLabel(s)}</DropdownMenu.RadioItem>
        {/each}
      </DropdownMenu.RadioGroup>
    </DropdownMenu.Content>
  </DropdownMenu.Root>
</form>
{#if change.error}<span class="text-xs text-red-300" role="alert">{change.error}</span>{/if}
{#if change.warning}<span class="text-xs text-amber-300">{change.warning}</span>{/if}
