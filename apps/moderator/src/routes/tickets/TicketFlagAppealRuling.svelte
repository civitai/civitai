<script lang="ts">
  import RulingForm, { emptyRulingDraft, type RulingDraft } from '$lib/components/RulingForm.svelte';
  import { FormState } from '$lib/form-state.svelte';
  import { FLAG_APPEAL_RULING_CHOICES } from '$lib/ruling-choices';
  import type { ResolutionVerdict } from '@civitai/shared/resolution-reasons';

  let {
    ticketId,
    userId,
    appealId,
    ondone,
  }: {
    ticketId: string;
    userId: number;
    appealId: number;
    ondone: (what: string, data: Record<string, unknown> | undefined) => void;
  } = $props();

  let draft = $state<RulingDraft<ResolutionVerdict<'flagAppeal'>>>(emptyRulingDraft());

  const form = new FormState({
    onSuccess: (data) => ondone('Appeal decided', data),
    reset: false,
  });
</script>

<div class="flex flex-col gap-1">
  <RulingForm
    subject="flagAppeal"
    choices={FLAG_APPEAL_RULING_CHOICES}
    action="?/appealResolveModelFlag"
    enhancer={form.enhance}
    idPrefix="ticket-flag-appeal-{appealId}"
    size="xs"
    confirm
    busy={form.submitting}
    disabled={form.submitting}
    bind:draft
  >
    {#snippet hidden()}
      <input type="hidden" name="ticketId" value={ticketId} />
      <input type="hidden" name="userId" value={userId} />
      <input type="hidden" name="appealId" value={appealId} />
    {/snippet}
  </RulingForm>
  {#if form.error}<p class="m-0 text-xs text-red-300">{form.error}</p>{/if}
  {#if form.warning}<p class="m-0 text-xs text-amber-300">{form.warning}</p>{/if}
</div>
