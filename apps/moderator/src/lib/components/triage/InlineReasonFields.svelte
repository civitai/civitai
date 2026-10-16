<script lang="ts" generics="S extends ResolutionSubject">
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import { NativeSelect } from '@civitai/ui/components/ui/native-select/index.js';
  // Used by the `generics=` attribute above, which ESLint cannot see.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  import type { ResolutionSubject } from '@civitai/shared/resolution-reasons';
  import {
    RESOLUTION_NOTE_MAX_LENGTH,
    reasonRequiresNote,
    resolutionReasonsFor,
    type ResolutionVerdict,
    type TextScanLabel,
  } from '@civitai/shared/resolution-reasons';

  /**
   * The reason and note of a ruling as two one-line controls, for a bar that has the room.
   * Posts the same `resolvedReason` and `internalNotes` fields as `ResolutionReasonFields`, and renders
   * a select and an input as two siblings so the parent form's grid places them.
   */
  let {
    subject,
    verdict,
    labels,
    reason = $bindable(''),
    note = $bindable(''),
  }: {
    subject: S;
    /** Null until a decision is chosen; the reasons offered depend on it. */
    verdict: ResolutionVerdict<S> | null;
    labels?: readonly TextScanLabel[];
    reason?: string;
    note?: string;
  } = $props();

  const reasons = $derived(verdict ? resolutionReasonsFor(subject, verdict, labels) : []);
  const noteRequired = $derived(reasonRequiresNote(reason));
</script>

<input type="hidden" name="resolvedReason" value={reason} />
<NativeSelect
  aria-label="Reason"
  disabled={!verdict}
  title={reasons.find((r) => r.value === reason)?.description}
  class="h-10 w-full text-sm"
  bind:value={reason}
>
  <option value="" disabled>{verdict ? 'Reason: choose one' : 'Reason: pick a decision first'}</option>
  {#each reasons as r (r.value)}
    <option value={r.value} title={r.description}>{r.label}</option>
  {/each}
</NativeSelect>
<Input
  name="internalNotes"
  aria-label="Note for the record"
  disabled={!verdict}
  maxlength={RESOLUTION_NOTE_MAX_LENGTH}
  required={noteRequired}
  bind:value={note}
  placeholder={noteRequired
    ? 'Say why (required for Other). Never shown to the user.'
    : 'Note for the record (optional)'}
  class="h-10 text-sm"
/>
