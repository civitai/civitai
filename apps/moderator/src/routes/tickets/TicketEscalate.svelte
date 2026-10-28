<script lang="ts">
  import { enhance } from '$app/forms';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Textarea } from '@civitai/ui/components/ui/textarea/index.js';
  import { toast } from '@civitai/ui/components/ui/sonner/index.js';
  import { FormState } from '$lib/form-state.svelte';
  import { LINK_CLASS } from '$lib/format';

  let { ticketId }: { ticketId: string } = $props();

  let confirming = $state(false);
  /** Set once the ticket has left the moderation view: the page's own load would now 404. */
  let sent = $state(false);

  const escalate = new FormState({
    onSuccess: (data) => {
      sent = true;
      if (typeof data?.warning !== 'string') toast.success('Sent to support');
    },
    onSettled: () => (confirming = false),
  });
</script>

<section class="mt-4 rounded-xl border border-dark-4 bg-dark-6 p-5">
  <h2 class="mb-1 text-white">Send to support</h2>
  {#if sent}
    <p class="text-sm">
      Done — ticket #{ticketId} is now in the support view, so it no longer opens here.
      <a class={LINK_CLASS} href="/tickets/moderation">Back to the moderation list</a>
    </p>
    {#if escalate.warning}<p class="mt-2 text-sm text-amber-400">{escalate.warning}</p>{/if}
  {:else}
    <p class="text-dark-2 mb-3 text-xs">
      Nothing is emailed to the customer, but the ticket leaves the moderators' queue and moves to
      Customer Support.
    </p>
    <form
      method="POST"
      action="?/escalate"
      use:enhance={escalate.enhance}
      class="flex flex-col gap-2"
    >
      <Textarea
        name="reason"
        rows={2}
        maxlength={500}
        placeholder="Optional reason, shown to support in a private note."
        disabled={escalate.submitting}
      />
      <!-- The confirm button is the only real submit; it must not unmount itself in its own click
           handler (the submit would never fire) — `confirming` closes from `onSettled` instead. -->
      <div class="flex flex-wrap items-center gap-2">
        {#if confirming}
          <span class="text-sm text-red-300">Remove this ticket from the moderation queue?</span>
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
        {:else}
          <Button
            type="button"
            size="sm"
            variant="outline"
            onclick={() => (confirming = true)}
            data-touch-target
          >
            Send to support
          </Button>
        {/if}
      </div>
      {#if escalate.error}<p class="text-sm text-red-400">{escalate.error}</p>{/if}
    </form>
  {/if}
</section>
