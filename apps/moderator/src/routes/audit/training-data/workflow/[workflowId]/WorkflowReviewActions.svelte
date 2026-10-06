<script lang="ts">
  import { enhance } from '$app/forms';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Checkbox } from '@civitai/ui/components/ui/checkbox/index.js';
  import { Label } from '@civitai/ui/components/ui/label/index.js';
  import { Textarea } from '@civitai/ui/components/ui/textarea/index.js';
  import { toast } from '@civitai/ui/components/ui/sonner/index.js';
  import { FormState } from '$lib/form-state.svelte';
  import { relativeTime } from '$lib/format';

  let {
    expiresAt,
    expiringSoon,
    viewable,
  }: {
    expiresAt: string;
    expiringSoon: boolean;
    /** Whether any dataset item probed viewable. Unless it did, Approve asks the moderator to confirm
     *  reviewing the dataset another way — asked until the probe answers. The server re-probes and
     *  refuses an approval without it; this is only how the page asks. */
    viewable: Promise<boolean>;
  } = $props();

  const VERDICTS: Record<string, string> = {
    '?/approve': 'Training run approved',
    '?/deny': 'Training run denied',
  };

  // Held here rather than on the page so `{#key workflowId}` around this component clears it: a
  // refusal or a half-typed reason must not carry over onto a different run.
  //
  // One FormState for both verdicts: one place for a refusal, and only one can be in flight. `reload`
  // re-reads the run, so the page then shows the orchestrator's state after the ruling, not ours.
  let verdict = '';
  // Held in state, not only in the checkbox: the `{#await}` below swaps the element when the probe
  // answers, and an uncontrolled tick would vanish with the old one.
  let reviewedElsewhere = $state(false);
  // The server re-probes at approve time and can disagree with this page's probe (a busy orchestrator,
  // a large dataset). When it refuses for want of the tick, the tick is offered whatever the page saw.
  let serverAsked = $state(false);
  const form = new FormState({
    reload: true,
    onSubmit: ({ action }) => (verdict = VERDICTS[action.search] ?? ''),
    onSuccess: () => {
      if (verdict) toast.success(verdict);
    },
    onSettled: (result) => {
      if (result.type === 'failure' && result.data?.needsAck === true) serverAsked = true;
    },
  });
</script>

{#snippet ack()}
  <div class="flex items-center gap-1.5" data-touch-target>
    <Checkbox
      id="reviewed-elsewhere"
      name="reviewedElsewhere"
      value="yes"
      bind:checked={reviewedElsewhere}
    />
    <Label for="reviewed-elsewhere" class="text-xs leading-snug font-normal text-dark-2">
      I reviewed this dataset another way
    </Label>
  </div>
{/snippet}

{#if expiringSoon}
  <p class="mb-3 text-sm text-amber-200">
    The gate expires {relativeTime(expiresAt)}. If it expires the run is cancelled and refunded.
  </p>
{/if}
<div class="mb-2 flex flex-wrap items-start gap-4">
  <form method="POST" action="?/approve" use:enhance={form.enhance} class="flex flex-col gap-2">
    <!-- Awaited here, not around this component, so the probe answering does not remount the deny
         reason the moderator may be typing. -->
    {#await viewable}
      {@render ack()}
    {:then canSee}
      {#if !canSee || serverAsked}{@render ack()}{/if}
    {:catch}
      {@render ack()}
    {/await}
    <Button type="submit" size="sm" disabled={form.submitting} class="self-start">Approve</Button>
  </form>
  <form method="POST" action="?/deny" use:enhance={form.enhance} class="flex flex-col gap-2">
    <Label for="deny-reason" class="text-xs text-dark-2">Reason (optional, shown to the user)</Label>
    <Textarea id="deny-reason" name="reason" rows={2} maxlength={1000} class="w-80 max-w-full" />
    <Button
      type="submit"
      size="sm"
      variant="destructive"
      disabled={form.submitting}
      class="self-start"
    >
      Deny
    </Button>
  </form>
</div>
<p class="mb-4 text-xs text-dark-2">
  Deny cancels the run and it is refunded in full. Neither ruling can be undone here.
</p>

{#if form.error}
  <p class="mb-4 text-sm text-red-300">{form.error}</p>
{/if}
