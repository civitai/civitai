<script lang="ts">
  import { enhance } from '$app/forms';
  import type { SubmitFunction } from '@sveltejs/kit';
  import { tick } from 'svelte';
  import { ratingReviewLevelLabel } from '@civitai/shared/rating-review';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Textarea } from '@civitai/ui/components/ui/textarea/index.js';
  import TriageDecisionBar from '$lib/components/triage/TriageDecisionBar.svelte';
  import TriageKeyButton from '$lib/components/triage/TriageKeyButton.svelte';
  import { disputeOutcome, isLowerOnly } from '$lib/rating-dispute';
  import { isDialogOpen } from '$lib/triage/keys';
  import type { Outcome } from '$lib/triage/queue';
  import type { RatingDisputeRow } from '$lib/server/rating-dispute-queue';

  let {
    row,
    submit,
    actionHref,
    chosen = $bindable(),
  }: {
    row: RatingDisputeRow;
    submit: (outcome: Outcome) => SubmitFunction;
    actionHref: (action: string) => string;
    chosen: number | null;
  } = $props();

  const levelLabel = (level: number) => ratingReviewLevelLabel(row.entityType, level);
  const outcome = $derived(
    chosen === null
      ? null
      : disputeOutcome(
          row.entityType,
          { current: row.currentLevel, suggested: row.suggestedLevel, chosen },
          row.entity !== null
        )
  );

  let confirmButton = $state<HTMLElement | null>(null);

  // Enter then confirms natively, whichever way the level was picked.
  $effect(() => {
    if (chosen !== null && confirmButton) void tick().then(() => confirmButton?.focus());
  });

  const decide: SubmitFunction = (input) => {
    const picked = input.submitter as HTMLButtonElement | null;
    if (picked?.name === 'appliedLevel') {
      input.cancel();
      chosen = Number(picked.value);
      return;
    }
    if (chosen === null || !outcome) {
      input.cancel();
      return;
    }
    const verdict = outcome.approves ? 'Approved' : 'Rejected';
    return submit(
      row.entity ? `${verdict}: applied ${levelLabel(chosen)}` : `${verdict}: content deleted`
    )(input);
  };

  const cancel = () => {
    chosen = null;
    document.querySelector<HTMLElement>('[data-triage-actions] [data-triage-key]')?.focus();
  };

  let formEl = $state<HTMLFormElement | null>(null);

  const onkeydown = (e: KeyboardEvent) => {
    if (chosen === null || e.defaultPrevented || isDialogOpen()) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      formEl?.requestSubmit();
    }
  };
</script>

{#snippet levelButtons()}
  <span class="text-sm text-dark-2">Apply rating</span>
  {#each row.levelOptions as level, i (level)}
    <TriageKeyButton
      type="submit"
      key={i + 1}
      tone={level === row.suggestedLevel ? 'blue' : undefined}
      selected={chosen === level}
      name="appliedLevel"
      value={level}
    >
      {levelLabel(level)}
      {#if level === row.suggestedLevel}
        <span class="text-[11px] font-normal text-blue-100">owner asks</span>
      {/if}
      {#if level === row.currentLevel}
        <span class="text-[11px] font-normal text-dark-2">current</span>
      {/if}
    </TriageKeyButton>
  {/each}
  {#if isLowerOnly(row.entityType)}
    <span class="text-xs text-dark-2">Challenges and crucibles can only be lowered here.</span>
  {/if}
{/snippet}

{#snippet confirmFields()}
  {#if outcome && chosen !== null}
    <div class="flex w-full flex-col gap-2">
      <p class="m-0 text-sm">
        <span class="font-semibold {outcome.approves ? 'text-green-300' : 'text-red-300'}">
          {outcome.label}
        </span>
        <span class="text-dark-0">{outcome.effect}</span>
      </p>
      <Textarea
        name="modComment"
        rows={2}
        maxlength={1000}
        placeholder="Note to owner (optional, they see this)"
        aria-label="Note to owner"
        class="rounded-md border-dark-4 bg-dark-7 text-[13px] dark:bg-dark-7"
      />
      <div class="flex items-center gap-2">
        <Button
          type="submit"
          bind:ref={confirmButton}
          class="h-8 rounded-md bg-blue-600 px-3.5 text-[13px] text-white hover:bg-blue-700"
        >
          Apply {levelLabel(chosen)}
        </Button>
        <Button type="button" variant="ghost" class="h-8 px-2.5 text-[13px]" onclick={cancel}>
          Cancel (Esc)
        </Button>
        <span class="text-[11px] text-dark-2">Enter confirms; Ctrl+Enter from the note.</span>
      </div>
    </div>
  {/if}
{/snippet}

<svelte:window {onkeydown} />

<form
  bind:this={formEl}
  method="POST"
  action={actionHref('resolve')}
  use:enhance={decide}
  class="w-full"
>
  <input type="hidden" name="reviewId" value={row.id} />
  {#if chosen !== null}<input type="hidden" name="appliedLevel" value={chosen} />{/if}
  <TriageDecisionBar
    buttons={levelButtons}
    fields={chosen !== null ? confirmFields : undefined}
    hint="Applying the owner's rating approves the dispute; any other rating rejects it. The owner sees the note."
  />
</form>
