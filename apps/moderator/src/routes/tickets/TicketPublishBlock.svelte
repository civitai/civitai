<script lang="ts">
  import { enhance } from '$app/forms';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { FormState } from '$lib/form-state.svelte';
  import { cancelUnlessConfirming } from '$lib/tickets/confirm-guard';

  let {
    ticketId,
    userId,
    modelId,
    cannotPublish,
    ondone,
  }: {
    ticketId: string;
    userId: number;
    modelId: number;
    /** The model's state now; the form asks for the opposite, and the server refuses if it has moved. */
    cannotPublish: boolean;
    ondone: (what: string, data: Record<string, unknown> | undefined) => void;
  } = $props();

  let confirming = $state(false);

  const form = new FormState({
    onSubmit: cancelUnlessConfirming(() => confirming),
    onSettled: () => (confirming = false),
    onSuccess: (data) => ondone(cannotPublish ? 'Publishing allowed' : 'Publishing blocked', data),
    reset: false,
  });
</script>

<form method="POST" action="?/loraSetPublishBlock" use:enhance={form.enhance} class="flex flex-col gap-1">
  <input type="hidden" name="ticketId" value={ticketId} />
  <input type="hidden" name="userId" value={userId} />
  <input type="hidden" name="modelId" value={modelId} />
  <input type="hidden" name="cannotPublish" value={cannotPublish ? 'false' : 'true'} />
  <!-- The confirm button is the only real submit; see TicketAccountAction. -->
  {#if confirming}
    <div class="flex flex-wrap items-center gap-1.5">
      <span class="w-full text-xs text-red-300">
        {cannotPublish
          ? 'The user can publish this model again.'
          : 'The user can no longer publish this model.'}
      </span>
      <Button type="submit" size="sm" disabled={form.submitting} data-touch-target>
        {cannotPublish ? 'Yes, allow' : 'Yes, block'}
      </Button>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={form.submitting}
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
      disabled={form.submitting}
      onclick={() => (confirming = true)}
      data-touch-target
    >
      {cannotPublish ? 'Allow publishing…' : 'Block publishing…'}
    </Button>
  {/if}
  {#if form.error}<p class="m-0 text-xs text-red-300">{form.error}</p>{/if}
  {#if form.warning}<p class="m-0 text-xs text-amber-300">{form.warning}</p>{/if}
</form>
