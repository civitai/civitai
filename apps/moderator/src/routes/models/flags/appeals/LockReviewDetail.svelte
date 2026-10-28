<script module lang="ts">
  import type { ResolutionVerdict } from '@civitai/shared/resolution-reasons';

  // Reject first, as in the flag appeal's bar.
  const RULINGS = [
    {
      verdict: 'Rejected',
      action: 'rejectLockReview',
      label: 'Reject, settings stay locked',
      outcome: 'Request rejected',
    },
    {
      verdict: 'Approved',
      action: 'approveLockReview',
      label: 'Approve, unlock settings',
      outcome: 'Settings unlocked',
    },
  ] as const satisfies readonly {
    verdict: ResolutionVerdict<'lockReview'>;
    action: string;
    label: string;
    outcome: string;
  }[];
</script>

<script lang="ts">
  import { enhance } from '$app/forms';
  import type { SubmitFunction } from '@sveltejs/kit';
  import { isRequestableLock, requestableLockLabels } from '@civitai/shared/lock-review';
  import { reasonRequiresNote, resolutionReasonsFor } from '@civitai/shared/resolution-reasons';
  import type { RulingDraft } from '$lib/components/RulingForm.svelte';
  import MetaChip from '$lib/components/minor-flags/MetaChip.svelte';
  import ModelFlagDetailFrame from '$lib/components/minor-flags/ModelFlagDetailFrame.svelte';
  import OwnerSaysCard from '$lib/components/minor-flags/OwnerSaysCard.svelte';
  import InlineReasonFields from '$lib/components/triage/InlineReasonFields.svelte';
  import ReasonPicker from '$lib/components/triage/ReasonPicker.svelte';
  import TriageDecisionBar from '$lib/components/triage/TriageDecisionBar.svelte';
  import TriageKeyButton from '$lib/components/triage/TriageKeyButton.svelte';
  import { waiting } from '$lib/minor-flags/appeal-row';
  import { modelFlagDetail } from '$lib/minor-flags/model-detail-request';
  import { MODEL_FLAGS_APPEALS_PATH } from '$lib/minor-flags/paths';
  import type { MinorFlagAppealRow } from '$lib/server/minor-hash.service';
  import {
    decisionReasonOptions,
    decisionReasonProblem,
    suggestedReason,
  } from '$lib/triage/decision-reasons';
  import {
    closeReasonPickerBeyond,
    noteReasonChosen,
    reasonPicker,
    resetReasonPicker,
    submitAwaitingNote,
  } from '$lib/triage/reason-picker.svelte';

  let {
    row,
    civitaiUrl,
    canViewTrainingData,
    verdict,
    error,
    submit,
    actionHref,
    draft = $bindable(),
  }: {
    row: MinorFlagAppealRow;
    civitaiUrl: string;
    canViewTrainingData: boolean;
    verdict: string | undefined;
    error: string | undefined;
    submit: (verdict: string) => SubmitFunction;
    actionHref: (action: string) => string;
    draft: RulingDraft<string>;
  } = $props();

  const detail = $derived(modelFlagDetail(MODEL_FLAGS_APPEALS_PATH, row.modelId, ''));
  const asked = $derived((row.lockReview ?? []).filter(isRequestableLock));
  const stillLocked = $derived(asked.filter((key) => row.lockedProperties.includes(key)));
  // Mirrors the endpoint, which refuses an approval once either flag is set.
  const flagged = $derived(row.minor || row.poi);

  type Verdict = (typeof RULINGS)[number]['verdict'];
  const unavailableFor = (key: Verdict) =>
    key === 'Approved' && flagged
      ? 'Flagged as a real person or a minor since the request; its locks stay.'
      : null;
  const reasonsFor = (key: Verdict) => resolutionReasonsFor('lockReview', key);

  const reasonOptions = $derived(
    decisionReasonOptions(RULINGS.map((r) => ({ label: r.label, reasons: reasonsFor(r.verdict) })))
  );
  // Rejecting takes one key: it has a single specific reason.
  const reason = $derived(draft.reason || suggestedReason(reasonsFor('Rejected')));
  $effect(() => () => resetReasonPicker());
  $effect(() => closeReasonPickerBeyond(RULINGS.length));
  let problem = $state<string | null>(null);
  let reasonSelect = $state<HTMLElement | null>(null);
  let noteInput = $state<HTMLInputElement | null>(null);

  const decide: SubmitFunction = (input) => {
    resetReasonPicker();
    const ruling = RULINGS.find((r) => r.verdict === input.formData.get('ruling'));
    const unavailable = ruling ? unavailableFor(ruling.verdict) : null;
    const refusal = !ruling
      ? 'Pick a decision.'
      : (unavailable ??
        decisionReasonProblem('lockReview', ruling.verdict, ruling.label, reason, draft.note));
    if (!ruling || refusal) {
      input.cancel();
      problem = refusal;
      if (!unavailable) reasonSelect?.focus();
      return;
    }
    problem = null;
    return submit(ruling.outcome)(input);
  };
</script>

{#snippet buttons()}
  {#each RULINGS as ruling, i (ruling.verdict)}
    {@const unavailable = unavailableFor(ruling.verdict)}
    <TriageKeyButton
      type="submit"
      key={i + 1}
      primary={i === 0}
      reasons
      name="ruling"
      value={ruling.verdict}
      formaction={actionHref(ruling.action)}
      disabled={!!unavailable}
      title={unavailable ?? undefined}
    >
      {ruling.label}
    </TriageKeyButton>
  {/each}
{/snippet}

{#snippet picker()}
  {@const ruling = reasonPicker.open === null ? undefined : RULINGS[reasonPicker.open]}
  {#if ruling}
    <ReasonPicker
      index={reasonPicker.open!}
      label={ruling.label}
      reasons={reasonsFor(ruling.verdict)}
      current={reason}
      note={draft.note}
      onreason={(next) => {
        draft = { ...draft, reason: next };
        problem = null;
      }}
      onneednote={() => noteInput?.focus()}
    />
  {/if}
{/snippet}

{#snippet fields()}
  <InlineReasonFields
    compact
    options={reasonOptions}
    bind:reason={
      () => reason,
      (next) => {
        draft = { ...draft, reason: next };
        problem = null;
        noteReasonChosen(reasonRequiresNote(next));
      }
    }
    bind:note={
      () => draft.note,
      (next) => {
        draft = { ...draft, note: next };
        problem = null;
      }
    }
    bind:select={reasonSelect}
    bind:noteInput
    onenter={() => submitAwaitingNote(RULINGS.length)}
  />
{/snippet}

<ModelFlagDetailFrame {row} {detail} {civitaiUrl} {canViewTrainingData} {verdict} {error}>
  {#snippet chips()}
    <MetaChip tone="blue" solid>locked setting</MetaChip>
    <MetaChip tone="amber">waiting {waiting(row.appealCreatedAt)}</MetaChip>
  {/snippet}

  {#snippet info()}
    <OwnerSaysCard
      message={row.appealMessage}
      appealedAt={row.appealCreatedAt}
      nthThisYear={row.appealNthThisYear}
    />
    <section class="rounded-md border border-dark-4 p-3 text-sm">
      <h3 class="m-0 mb-2 text-xs font-semibold uppercase text-dark-2">Settings asked about</h3>
      <ul class="m-0 flex list-none flex-col gap-1 p-0">
        {#each asked as key (key)}
          <li class="flex items-center gap-2">
            <span>{requestableLockLabels[key]}</span>
            {#if stillLocked.includes(key)}
              <MetaChip tone="amber">locked</MetaChip>
            {:else}
              <MetaChip tone="green">already unlocked</MetaChip>
            {/if}
          </li>
        {/each}
      </ul>
      <p class="m-0 mt-2 text-xs text-dark-2">
        Approving unlocks only these settings, and leaves their values as they are.
      </p>
    </section>
  {/snippet}

  {#snippet decision()}
    <form method="POST" action={actionHref('rejectLockReview')} use:enhance={decide} class="w-full">
      <input type="hidden" name="modelId" value={row.modelId} />
      <TriageDecisionBar
        compact
        {buttons}
        picker={reasonPicker.open !== null ? picker : undefined}
        {fields}
        {problem}
      />
    </form>
  {/snippet}
</ModelFlagDetailFrame>
