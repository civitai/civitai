<script lang="ts">
  import { tick } from 'svelte';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Kbd } from '@civitai/ui/components/ui/kbd/index.js';
  import { reasonRequiresNote, type ResolutionReason } from '@civitai/shared/resolution-reasons';
  import { clickDecision, keepsNativeEnter } from '$lib/triage/decision-form';
  import { suggestedReason } from '$lib/triage/decision-reasons';
  import { isTypingTarget, reasonPickerKeyAction } from '$lib/triage/keys';
  import {
    awaitReasonNote,
    closeReasonPicker,
    noteReasonChosen,
  } from '$lib/triage/reason-picker.svelte';

  /**
   * The second press of a decision key: the reasons of one decision, each behind a digit. A digit (or a
   * click) records that reason and submits the decision, Enter submits the selected one, Escape closes.
   * A reason that needs a note moves to the note field instead of submitting.
   */
  let {
    index,
    label,
    reasons,
    current,
    note,
    onreason,
    onneednote,
  }: {
    /** The decision this list is for, in key order. */
    index: number;
    label: string;
    reasons: readonly ResolutionReason[];
    /** The reason already in the bar. */
    current: string;
    note: string;
    onreason: (value: string) => void;
    onneednote: () => void;
  } = $props();

  const shown = $derived(reasons.slice(0, 9));
  const selected = $derived(
    shown.some((r) => r.value === current) ? current : suggestedReason(shown)
  );

  // Closes the list when the bar goes. It leaves the wait for a note alone: `choose` sets that just
  // before this list unmounts, and the form clears it when the bar itself goes.
  $effect(() => () => closeReasonPicker());

  const choose = async (value: string) => {
    // Read before closing: callers pass `index={reasonPicker.open}`, which a closed list turns to
    // null, and `clickDecision(null)` presses the first decision.
    const decision = index;
    onreason(value);
    closeReasonPicker();
    const needsNote = reasonRequiresNote(value);
    noteReasonChosen(needsNote);
    if (needsNote && !note.trim()) {
      awaitReasonNote(decision);
      onneednote();
      return;
    }
    // Let the bar's reason update before the decision reads it.
    await tick();
    clickDecision(decision);
  };

  function onkeydown(e: KeyboardEvent) {
    const target = e.target as Element | null;
    const action = reasonPickerKeyAction({
      key: e.key,
      ctrlKey: e.ctrlKey,
      metaKey: e.metaKey,
      altKey: e.altKey,
      repeat: e.repeat,
      typing: isTypingTarget(target),
      onControl: keepsNativeEnter(target),
      reasonCount: shown.length,
      hasSelection: !!selected,
    });
    if (!action) return;
    e.preventDefault();
    if (action === 'close') closeReasonPicker();
    else if (action === 'submit') choose(selected);
    else choose(shown[action.pick].value);
  }
</script>

<svelte:window {onkeydown} />

<div
  role="group"
  aria-label="Pick a reason"
  class="flex flex-wrap items-center gap-1.5 rounded-md border border-dark-4 bg-dark-7 p-2"
>
  <span class="mr-1 text-xs text-dark-2">Reason for “{label}”:</span>
  {#each shown as r, i (r.value)}
    <Button
      type="button"
      variant="outline"
      size="sm"
      title={r.description}
      aria-pressed={r.value === selected}
      class={[
        'h-7 gap-1.5 border-dark-4 bg-transparent px-2.5 text-[13px] text-dark-0 dark:bg-transparent',
        r.value === selected && 'border-blue-5',
      ]}
      onclick={() => choose(r.value)}
    >
      <Kbd class="h-[13px] min-w-0 rounded-[3px] bg-black/25 px-[5px] text-[11px] font-semibold">
        {i + 1}
      </Kbd>
      {r.label}
    </Button>
  {/each}
  <span class="ml-auto text-[11px] text-dark-2">
    {selected ? 'Enter submits the highlighted reason · ' : ''}Esc cancels
  </span>
</div>
