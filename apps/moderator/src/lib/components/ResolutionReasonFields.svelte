<script lang="ts" generics="S extends ResolutionSubject">
  import { Label } from '@civitai/ui/components/ui/label/index.js';
  import { Textarea } from '@civitai/ui/components/ui/textarea/index.js';
  import { cn } from '@civitai/ui/utils.js';
  // Used by the `generics=` attribute above, which ESLint cannot see.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  import type { ResolutionSubject } from '@civitai/shared/resolution-reasons';
  import {
    RESOLUTION_NOTE_MAX_LENGTH,
    reasonRequiresNote,
    resolutionReasonsFor,
    type ResolutionVerdict,
  } from '@civitai/shared/resolution-reasons';

  let {
    subject,
    verdict,
    idPrefix,
    reason = $bindable(''),
    note = $bindable(''),
    showNote = true,
  }: {
    subject: S;
    verdict: ResolutionVerdict<S>;
    /** Unique per mounted picker, so two on one page do not share label targets. */
    idPrefix: string;
    reason?: string;
    note?: string;
    /** Off where the surrounding form already has the note field (the ban form's `detailsInternal`). */
    showNote?: boolean;
  } = $props();

  const reasons = $derived(resolutionReasonsFor(subject, verdict));
</script>

<fieldset class="grid gap-1.5">
  <legend class="mb-1 text-xs tracking-wide text-dark-2 uppercase">Reason</legend>
  <input type="hidden" name="resolvedReason" value={reason} />
  <div class="flex flex-wrap gap-1.5">
    {#each reasons as r (r.value)}
      <button
        type="button"
        title={r.description}
        onclick={() => (reason = r.value)}
        aria-pressed={reason === r.value}
        class={cn(
          'rounded-md border px-2 py-1 text-xs',
          reason === r.value
            ? 'border-primary bg-primary/15 text-white'
            : 'border-dark-4 text-dark-2 hover:bg-dark-5 hover:text-dark-0'
        )}
      >
        {r.label}
      </button>
    {/each}
  </div>
  {#if reason}
    <p class="text-xs text-dark-2">{reasons.find((r) => r.value === reason)?.description}</p>
  {/if}
  {#if showNote}
    <Label for="{idPrefix}-note" class="sr-only">Internal note</Label>
    <Textarea
      id="{idPrefix}-note"
      name="internalNotes"
      rows={2}
      maxlength={RESOLUTION_NOTE_MAX_LENGTH}
      bind:value={note}
      required={reasonRequiresNote(reason)}
      placeholder={reasonRequiresNote(reason)
        ? 'Say why (required for Other). Never shown to the user.'
        : 'Internal note (optional). Never shown to the user.'}
    />
  {/if}
</fieldset>
