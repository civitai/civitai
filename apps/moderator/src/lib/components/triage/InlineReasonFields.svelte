<script lang="ts">
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import * as Select from '@civitai/ui/components/ui/select/index.js';
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
    noteInput = $bindable(null),
    onenter,
  }: {
    /** Every decision's reasons, grouped by decision. */
    options: DecisionReasons;
    reason?: string;
    note?: string;
    /** The select's trigger, for focusing it when a decision is refused for want of a reason. */
    select?: HTMLElement | null;
    /** The note field, for moving to it when a reason needs a note. */
    noteInput?: HTMLInputElement | null;
    /** Enter in the note field, once a reason has asked for a note. */
    onenter?: () => void;
  } = $props();

  const noteRequired = $derived(reasonRequiresNote(reason));
  const picked = $derived(
    [...options.groups.flatMap((g) => g.reasons), ...options.shared].find((r) => r.value === reason)
  );
</script>

<!-- Posts `resolvedReason` through the Select's own hidden input. -->
<Select.Root type="single" name="resolvedReason" bind:value={reason}>
  <Select.Trigger
    bind:ref={select}
    aria-label="Reason"
    title={picked?.description}
    class="h-[30px] w-[260px] max-w-full shrink-0 justify-between border-dark-4 bg-dark-7 text-[13px] text-dark-0 dark:bg-dark-7 dark:hover:bg-dark-6"
  >
    <span class="truncate">Reason: {picked?.label ?? 'choose one'}</span>
  </Select.Trigger>
  <Select.Content>
    {#each options.groups as group (group.label)}
      <Select.Group>
        <Select.GroupHeading>{group.label}</Select.GroupHeading>
        {#each group.reasons as r (r.value)}
          <Select.Item value={r.value} label={r.label} title={r.description}>{r.label}</Select.Item>
        {/each}
      </Select.Group>
    {/each}
    {#if options.shared.length}
      <Select.Separator />
      {#each options.shared as r (r.value)}
        <Select.Item value={r.value} label={r.label} title={r.description}>{r.label}</Select.Item>
      {/each}
    {/if}
  </Select.Content>
</Select.Root>
<Input
  name="internalNotes"
  aria-label="Note for the record"
  maxlength={RESOLUTION_NOTE_MAX_LENGTH}
  required={noteRequired}
  bind:value={note}
  bind:ref={noteInput}
  onkeydown={(e) => {
    // Enter would submit with the form's first button, a decision nobody picked.
    if (e.key === 'Enter') {
      e.preventDefault();
      onenter?.();
    }
  }}
  placeholder={noteRequired
    ? 'Say why (required for Other). Never shown to the user.'
    : 'Note for the record (optional)'}
  class="h-[30px] min-w-0 flex-1 border-dark-4 bg-dark-7 text-[13px] placeholder:text-dark-2 dark:bg-dark-7"
/>
