<script lang="ts">
  import { browser } from '$app/environment';
  import { enhance } from '$app/forms';
  import type { SubmitFunction } from '@sveltejs/kit';
  import { tick } from 'svelte';
  import { IconLock } from '@tabler/icons-svelte';
  import * as AlertDialog from '@civitai/ui/components/ui/alert-dialog/index.js';
  import { Checkbox } from '@civitai/ui/components/ui/checkbox/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import FactRow from '$lib/components/minor-flags/FactRow.svelte';
  import FlagBadge from '$lib/components/minor-flags/FlagBadge.svelte';
  import MetaChip from '$lib/components/minor-flags/MetaChip.svelte';
  import ModelDetailHeader from '$lib/components/minor-flags/ModelDetailHeader.svelte';
  import ModelFactsCard from '$lib/components/minor-flags/ModelFactsCard.svelte';
  import PreviewImagesCard from '$lib/components/minor-flags/PreviewImagesCard.svelte';
  import UploaderCard from '$lib/components/minor-flags/UploaderCard.svelte';
  import HighlightedFields from '$lib/components/model-rule-holds/HighlightedFields.svelte';
  import HoldHistoryCard from '$lib/components/model-rule-holds/HoldHistoryCard.svelte';
  import MatchedRulesCard from '$lib/components/model-rule-holds/MatchedRulesCard.svelte';
  import TriageCard from '$lib/components/triage/TriageCard.svelte';
  import TriageDecisionBar from '$lib/components/triage/TriageDecisionBar.svelte';
  import TriageDetailFrame from '$lib/components/triage/TriageDetailFrame.svelte';
  import TriageKeyButton from '$lib/components/triage/TriageKeyButton.svelte';
  import { LINK_CLASS, dateTime, plural, shortAge } from '$lib/format';
  import { modelUrl } from '$lib/minor-flags/appeal-row';
  import { fetchModelFlagDetail } from '$lib/minor-flags/model-detail';
  import {
    BATCH_DECISIONS,
    BATCH_MAX,
    MODEL_RULE_MATCHES_PATH,
    modelStatusLabel,
    NOTE_MAX_LENGTH,
    decisionButtons,
    decisionOutcome,
    heldOutcome,
    holdDecisionEnabled,
    modeLabel,
    type ModelRuleHoldDecision,
  } from '$lib/model-rule-holds';
  import {
    fetchHoldContext,
    forgetHoldContexts,
    type HoldContext,
    type OwnerResult,
  } from '$lib/model-rule-holds-context';
  import { SSR_PENDING } from '$lib/ssr-pending';
  import type { Outcome } from '$lib/triage/queue';
  import type { PageData } from './$types';

  type Row = PageData['items'][number];

  let {
    row,
    civitaiUrl,
    canStrike,
    verdict,
    error,
    submit,
    actionHref,
    onothers,
    onreload,
  }: {
    row: Row;
    civitaiUrl: string;
    /** Holds `user.strike`. */
    canStrike: boolean;
    verdict: string | undefined;
    error: string | undefined;
    submit: (outcome: Outcome) => SubmitFunction;
    actionHref: (action: string) => string;
    /** What the decision did to the owner's other holds, when it was applied to them as well. */
    onothers: (decision: string, results: OwnerResult[]) => void;
    /** Reloads the queue after a refusal that asks for it. */
    onreload: () => void;
  } = $props();

  const decidedRow = $derived(row.status !== 'Pending');
  const dismissedRow = $derived(row.status === 'Dismissed');
  const keys = $derived(decisionButtons(row.mode));
  const enabled = $derived(holdDecisionEnabled(row, { canStrike }));
  const subjects = $derived(row.rules.map((rule) => rule.subject).join(', '));

  // Derived, never an effect: the shell keys the detail per row.
  const modelId = $derived(row.modelId);
  const detail = $derived(
    browser ? fetchModelFlagDetail(MODEL_RULE_MATCHES_PATH, modelId) : SSR_PENDING
  );
  const holdId = $derived(row.id);
  const context = $derived<Promise<HoldContext>>(
    browser ? fetchHoldContext(holdId) : SSR_PENDING
  );
  const history = $derived(context.then((c) => c.history));

  let formEl: HTMLFormElement | undefined = $state();
  let decision = $state<ModelRuleHoldDecision>('dismiss_allowed');
  let confirming = $state<ModelRuleHoldDecision | null>(null);
  let confirmOpen = $state(false);
  let applyToOwner = $state(false);
  let also = $state<{ holdId: number; textHash: string }[]>([]);
  let covered = $state(0);

  const pendingOf = (loaded: HoldContext) => loaded.owner?.pending ?? [];
  const batchable = (next: ModelRuleHoldDecision) =>
    next === 'confirm_strike' || BATCH_DECISIONS.includes(next);

  const targetsFor = async (next: ModelRuleHoldDecision) => {
    if (!applyToOwner || !batchable(next)) return [];
    const loaded = await context.catch(() => null);
    return loaded
      ? pendingOf(loaded)
          .slice(0, BATCH_MAX)
          .map((hold) => ({ holdId: hold.id, textHash: hold.textHash }))
      : [];
  };

  // One form and one note for every action; the hidden field carries which button was pressed.
  async function decide(next: ModelRuleHoldDecision, targets: typeof also) {
    decision = next;
    also = targets;
    await tick();
    formEl?.requestSubmit();
  }

  const takesDown = (next: ModelRuleHoldDecision) => next === 'confirm' || next === 'confirm_strike';

  const press = async (next: ModelRuleHoldDecision) => {
    const targets = await targetsFor(next);
    if (takesDown(next) || targets.length) {
      covered = targets.length;
      also = targets;
      confirming = next;
      confirmOpen = true;
    } else void decide(next, targets);
  };

  const ask = (next: ModelRuleHoldDecision, count: number) => {
    const auto = row.mode === 'active';
    const base = takesDown(next)
      ? {
          title: auto ? 'Keep this model down?' : 'Unpublish this model?',
          description: auto
            ? 'The model stays taken down and the hold is confirmed.'
            : 'The model is unpublished as a violation and the hold is confirmed.',
          label: auto ? 'Keep down' : 'Unpublish',
        }
      : {
          title: 'Dismiss this hold?',
          description: auto
            ? 'The model is republished and these matches are cleared for this text.'
            : 'The hold is closed and nothing changes on the model.',
          label: 'Dismiss',
        };
    return {
      ...base,
      description: `${base.description}${next === 'confirm_strike' ? ' The owner is struck once, with this hold.' : ''}${
        count
          ? ` The same ruling is applied to ${plural(count, 'other pending hold')} by this owner, without you opening them (no strike), and each is recorded as a batch decision.`
          : ''
      }`,
    };
  };

  const outcome = () => decisionOutcome(decision, row.mode);

  const decided: SubmitFunction = (input) => {
    const inner = submit(outcome)(input);
    return async (opts) => {
      const finish = await inner;
      // Before the shell moves on, so it skips the holds just closed.
      if (opts.result.type === 'success') {
        forgetHoldContexts();
        const others = (opts.result.data as { others?: OwnerResult[] } | undefined)?.others;
        if (others) onothers(String(input.formData.get('decision')), others);
      }
      await finish?.(opts);
    };
  };

  const whyDisabled = (key: ModelRuleHoldDecision) => {
    if (key === 'confirm_strike' && !canStrike)
      return 'Striking needs the “Strike or notify an account” permission.';
    if (key === 'confirm_strike' && row.userId === null) return 'The owner of this model is unknown.';
    return undefined;
  };
</script>

<TriageDetailFrame {verdict} {error}>
  {#snippet children()}
    <ModelDetailHeader
      modelId={row.modelId}
      modelName={row.modelName ?? `Model #${row.modelId}`}
      userId={row.userId ?? 0}
      {civitaiUrl}
      {detail}
    >
      {#snippet chips()}
        <MetaChip tone={row.mode === 'active' ? 'amber' : 'blue'}>{modeLabel(row.mode)}</MetaChip>
        {#if row.applied}<MetaChip tone="red" solid>taken down</MetaChip>{/if}
        {#if row.modelStatus && row.modelStatus !== 'Published'}
          <MetaChip>{modelStatusLabel(row.modelStatus)}</MetaChip>
        {/if}
        {#if row.redetected}<MetaChip tone="amber">re-detected</MetaChip>{/if}
        {#if row.source === 'training'}<MetaChip tone="amber">Training</MetaChip>{/if}
        {#if row.uploadType === 'Trained'}<MetaChip>Trained on Civitai</MetaChip>{/if}
        {#if row.editedSince}<MetaChip tone="green">edited since</MetaChip>{/if}
        {#if row.poi}<FlagBadge label="poi" />{/if}
        {#if row.minor}<FlagBadge label="minor" />{/if}
        <MetaChip>held {shortAge(row.createdAt)} ago</MetaChip>
      {/snippet}
    </ModelDetailHeader>

    {#if decidedRow}
      <TriageCard dense title="Decision" accent={dismissedRow ? 'neutral' : 'red'}>
        <dl class="m-0 space-y-1.5">
          <FactRow label="Outcome">{heldOutcome(row)}</FactRow>
          <FactRow label="By">{row.decidedByUsername ?? 'an unknown moderator'}</FactRow>
          <FactRow label="When">{dateTime(row.decidedAt)}</FactRow>
          <FactRow label="Note"
            ><span class="whitespace-pre-wrap break-words">{row.decisionNote ?? '—'}</span></FactRow
          >
        </dl>
      </TriageCard>
    {:else if row.editedSince}
      <p class="m-0 text-[13px] text-dark-0">
        <MetaChip tone="green">edited since</MetaChip>
        The latest scan of this model read different text; the text held here may no longer be on it.
        The main app refuses a ruling on text that changed, so this hold may need to be superseded by the
        next scan first.
      </p>
    {/if}

    <MatchedRulesCard rules={row.rules} matches={row.matches} />

    <TriageCard dense title="Scanned text">
      <HighlightedFields fields={row.fields} matches={row.matches} />
    </TriageCard>

    <PreviewImagesCard images={row.coverImages} allHref={modelUrl(civitaiUrl, row.modelId)} />

    <div class="grid gap-4 md:grid-cols-2">
      <ModelFactsCard
        row={{ modelType: row.modelType ?? 'Unknown', ...row.facts }}
        {detail}
      />
      <UploaderCard
        row={{
          userId: row.userId ?? 0,
          username: row.username,
          otherFlaggedModels: row.otherHeldModels,
        }}
        {detail}
        otherLabel="other model with a rule match"
        otherLabelMany="other models with rule matches"
      />
    </div>

    <HoldHistoryCard modelId={row.modelId} {history} />
  {/snippet}
  {#snippet actions()}
    {#if decidedRow}
      <p class="m-0 flex items-center gap-1.5 text-sm text-dark-2">
        <IconLock class="size-3.5" aria-hidden="true" /> This hold is already decided.
      </p>
    {:else}
      {#if error && /reload/i.test(error)}
        <!-- Stale and superseded refusals both tell the moderator to reload; the current hold arrives with it. -->
        <button type="button" class="text-[13px] {LINK_CLASS}" onclick={onreload}>
          Reload the queue
        </button>
      {/if}
      <form
        bind:this={formEl}
        method="POST"
        action={actionHref('decide')}
        use:enhance={decided}
        class="min-w-0 flex-1"
      >
        <input type="hidden" name="holdId" value={row.id} />
        <input type="hidden" name="textHash" value={row.textHash} />
        <input type="hidden" name="decision" value={decision} />
        {#if also.length}<input type="hidden" name="also" value={JSON.stringify(also)} />{/if}
        <TriageDecisionBar
          hint={row.source === 'training'
            ? `A training run matched ${subjects || 'the rule'}${row.mode === 'active' ? ' and was refused' : ' and went ahead'}. Confirm records it as a violation; a dismissal lets the same text through next time. J/K to move.`
            : row.mode === 'active'
            ? `The model was taken down when ${subjects || 'the rule'} matched. Confirm keeps it down; a dismissal republishes it.`
            : 'The model is still live. Confirm unpublishes it; a dismissal changes nothing on the model. J/K to move.'}
        >
          {#snippet buttons()}
            {#each keys as b, i (b.decision)}
              <TriageKeyButton
                type="button"
                key={i + 1}
                tone={b.tone}
                disabled={!enabled[i]}
                title={enabled[i] ? undefined : whyDisabled(b.decision)}
                onclick={() => press(b.decision)}
              >
                {b.label}
              </TriageKeyButton>
            {/each}
          {/snippet}
          {#snippet fields()}
            {#await context then loaded}
              {@const pending = pendingOf(loaded)}
              {#if pending.length}
                <div class="flex shrink-0 items-center gap-2 text-[13px] text-dark-0">
                  <Checkbox id="apply-to-owner" bind:checked={applyToOwner} />
                  <label for="apply-to-owner">
                    Also apply to this owner’s {plural(pending.length, 'other pending hold')}{pending.length > BATCH_MAX
                      ? ` (${BATCH_MAX} at a time)`
                      : ''}; no strike
                  </label>
                </div>
              {/if}
            {/await}
            <!-- Enter in the only text field would otherwise submit the form as a dismissal. -->
            <Input
              name="note"
              maxlength={NOTE_MAX_LENGTH}
              placeholder="Note for the record (optional)"
              aria-label="Decision note"
              class="h-8 min-w-0 flex-1 border-dark-4 bg-dark-7 text-[13px] dark:bg-dark-7"
              onkeydown={(e: KeyboardEvent) => {
                if (e.key === 'Enter') e.preventDefault();
              }}
            />
          {/snippet}
        </TriageDecisionBar>
      </form>
      <AlertDialog.Root bind:open={confirmOpen}>
        <AlertDialog.Content>
          {#if confirming}
            {@const copy = ask(confirming, covered)}
            <AlertDialog.Header>
              <AlertDialog.Title>{copy.title}</AlertDialog.Title>
              <AlertDialog.Description>{copy.description}</AlertDialog.Description>
            </AlertDialog.Header>
            <AlertDialog.Footer>
              <AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
              <AlertDialog.Action
                variant={takesDown(confirming) ? 'destructive' : 'default'}
                onclick={() => {
                  confirmOpen = false;
                  void decide(confirming!, also);
                }}>{copy.label}</AlertDialog.Action
              >
            </AlertDialog.Footer>
          {/if}
        </AlertDialog.Content>
      </AlertDialog.Root>
    {/if}
  {/snippet}
</TriageDetailFrame>
