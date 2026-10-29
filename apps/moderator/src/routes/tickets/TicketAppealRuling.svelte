<script lang="ts">
  import { Label } from '@civitai/ui/components/ui/label/index.js';
  import { Textarea } from '@civitai/ui/components/ui/textarea/index.js';
  import RulingForm, { emptyRulingDraft, type RulingDraft } from '$lib/components/RulingForm.svelte';
  import { FormState } from '$lib/form-state.svelte';
  import { appealRulingChoices } from '$lib/ruling-choices';
  import type { ResolutionVerdict } from '@civitai/shared/resolution-reasons';

  type Verdict = ResolutionVerdict<'appeal'>;

  /** The form action each kind of appeal is decided by, and whether the decision carries a message to the user. */
  const KINDS = {
    image: { action: 'appealResolveImage', message: false },
    removed: { action: 'appealResolveRemoved', message: true },
    site: { action: 'appealResolveSite', message: true },
    account: { action: 'appealResolveAccount', message: true },
  } as const;

  let {
    ticketId,
    userId,
    appealId,
    kind,
    blocked = null,
    ondone,
  }: {
    ticketId: string;
    userId: number;
    appealId: number;
    kind: keyof typeof KINDS;
    /** Why an approval is unavailable, or null. */
    blocked?: string | null;
    ondone: (what: string, data: Record<string, unknown> | undefined) => void;
  } = $props();

  const CHOICES = appealRulingChoices();
  const spec = $derived(KINDS[kind]);
  let draft = $state<RulingDraft<Verdict>>(emptyRulingDraft<Verdict>());
  // Shown to the appellant as written, so each verdict keeps its own wording.
  const messages = $state<Partial<Record<Verdict, string>>>({});

  const form = new FormState({
    onSuccess: (data) => ondone('Appeal decided', data),
    reset: false,
  });
</script>

<div class="flex flex-col gap-1">
  <RulingForm
    subject="appeal"
    choices={CHOICES}
    action="?/{spec.action}"
    enhancer={form.enhance}
    idPrefix="ticket-appeal-{appealId}"
    size="xs"
    confirm
    busy={form.submitting}
    disabled={form.submitting}
    choiceDisabled={(v) => (v === 'Approved' ? blocked : null)}
    bind:draft
  >
    {#snippet hidden()}
      <input type="hidden" name="ticketId" value={ticketId} />
      <input type="hidden" name="userId" value={userId} />
      <input type="hidden" name="appealId" value={appealId} />
    {/snippet}
    {#snippet extra()}
      {#if spec.message}
        <Label for="ticket-appeal-{appealId}-message" class="text-xs text-dark-2">
          Message to the user (optional, shown to them as written)
        </Label>
        <Textarea
          id="ticket-appeal-{appealId}-message"
          name="resolvedMessage"
          bind:value={() => (draft.verdict ? (messages[draft.verdict] ?? '') : ''),
            (v) => {
              if (draft.verdict) messages[draft.verdict] = v;
            }}
          rows={2}
          maxlength={1000}
        />
      {/if}
    {/snippet}
  </RulingForm>
  {#if form.error}<p class="m-0 text-xs text-red-300">{form.error}</p>{/if}
  {#if form.warning}<p class="m-0 text-xs text-amber-300">{form.warning}</p>{/if}
</div>
