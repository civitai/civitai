<script lang="ts">
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import { NativeSelect } from '@civitai/ui/components/ui/native-select/index.js';
  import { RESOLUTION_NOTE_MAX_LENGTH, reasonRequiresNote } from '@civitai/shared/resolution-reasons';
  import type { DecisionReasons } from '$lib/triage/decision-reasons';

  /**
   * The reason and note of a one-step ruling, picked before the decision button that submits them.
   * Posts `resolvedReason` and `internalNotes`, the fields `ResolutionReasonFields` posts, as two
   * siblings for the parent row to lay out.
   */
  let {
    options,
    reason = $bindable(''),
    note = $bindable(''),
    select = $bindable(null),
  }: {
    /** Every decision's reasons, grouped by decision. */
    options: DecisionReasons;
    reason?: string;
    note?: string;
    /** The select, for focusing it when a decision is refused for want of a reason. */
    select?: HTMLSelectElement | null;
  } = $props();

  const noteRequired = $derived(reasonRequiresNote(reason));
  const description = $derived(
    [...options.groups.flatMap((g) => g.reasons), ...options.shared].find((r) => r.value === reason)
      ?.description
  );
</script>

<div class="relative shrink-0">
  <span
    aria-hidden="true"
    class="pointer-events-none absolute top-1/2 left-2.5 z-10 -translate-y-1/2 text-[13px] text-dark-0"
  >
    Reason:
  </span>
  <NativeSelect
    name="resolvedReason"
    aria-label="Reason"
    title={description}
    bind:ref={select}
    bind:value={reason}
    class="h-[30px] w-[260px] max-w-full border-dark-4 bg-dark-7 py-0 ps-[3.9rem] text-[13px] text-dark-0 dark:bg-dark-7"
  >
    <option value="" disabled>choose one</option>
    {#each options.groups as group (group.label)}
      <optgroup label={group.label}>
        {#each group.reasons as r (r.value)}
          <option value={r.value} title={r.description}>{r.label}</option>
        {/each}
      </optgroup>
    {/each}
    {#each options.shared as r (r.value)}
      <option value={r.value} title={r.description}>{r.label}</option>
    {/each}
  </NativeSelect>
</div>
<Input
  name="internalNotes"
  aria-label="Note for the record"
  maxlength={RESOLUTION_NOTE_MAX_LENGTH}
  required={noteRequired}
  bind:value={note}
  onkeydown={(e) => {
    // Enter would submit with the form's first button, a decision nobody picked.
    if (e.key === 'Enter') e.preventDefault();
  }}
  placeholder={noteRequired
    ? 'Say why (required for Other). Never shown to the user.'
    : 'Note for the record (optional)'}
  class="h-[30px] min-w-0 flex-1 border-dark-4 bg-dark-7 text-[13px] placeholder:text-dark-2 dark:bg-dark-7"
/>
