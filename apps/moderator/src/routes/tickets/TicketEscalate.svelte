<script lang="ts">
  import { enhance } from '$app/forms';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import { FormState } from '$lib/form-state.svelte';
  import { denied } from '$lib/permissions';
  import { cancelUnlessConfirming } from '$lib/tickets/confirm-guard';

  let {
    ticketId,
    canEscalate,
    ondone,
  }: {
    ticketId: string;
    /** False renders the controls disabled, with the reason. */
    canEscalate: boolean;
    ondone: (what: string, data: Record<string, unknown> | undefined, status: number | null) => void;
  } = $props();

  let confirming = $state(false);

  const escalate = new FormState({
    onSubmit: cancelUnlessConfirming(() => confirming),
    onSuccess: (data) => ondone('Sent to support', data, null),
    onSettled: () => (confirming = false),
  });
  const why = $derived(canEscalate ? undefined : denied('tickets.escalate'));
</script>

<form
  method="POST"
  action="?/escalate"
  use:enhance={escalate.enhance}
  class="flex flex-col gap-1.5 border-t border-dark-4 pt-2.5"
>
  <input type="hidden" name="ticketId" value={ticketId} />
  <Input
    name="reason"
    maxlength={500}
    placeholder="Optional reason, noted for support"
    disabled={!canEscalate || escalate.submitting}
    title={why}
    class="h-8 text-[13px]"
  />
  {#if confirming}
    <div class="flex flex-wrap items-center gap-1.5">
      <span class="w-full text-xs text-red-300">
        Nothing is emailed, but the ticket leaves the moderators' queue.
      </span>
      <Button type="submit" size="sm" disabled={escalate.submitting} data-touch-target>
        Yes, send to support
      </Button>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={escalate.submitting}
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
      variant="outline"
      disabled={!canEscalate || escalate.submitting}
      title={why}
      onclick={() => (confirming = true)}
      data-touch-target
    >
      Send to support…
    </Button>
  {/if}
  {#if escalate.error}<p class="m-0 text-xs text-red-300">{escalate.error}</p>{/if}
  {#if escalate.warning}<p class="m-0 text-xs text-amber-300">{escalate.warning}</p>{/if}
  {#if why}<p class="m-0 text-[11px] text-amber-300">{why}</p>{/if}
</form>
