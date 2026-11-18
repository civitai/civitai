<script module lang="ts">
  import { browsingLevels, NsfwLevel } from '@civitai/shared';
  import { KNIGHTS_BLOCK_REASONS } from '@civitai/shared/new-order';
  import type { ResolutionReason } from '@civitai/shared/resolution-reasons';
  import type { InquisitorItem } from '$lib/server/knights/inquisitor.service';

  /** Keys 1 to 5 are the ratings, in `browsingLevels` order; the last key is Blocked, which asks for a reason. */
  const BLOCKED_INDEX = browsingLevels.length;
  const DECISION_COUNT = BLOCKED_INDEX + 1;

  /** A blocked image takes only Blocked: the ruling refuses any other level on it. */
  export const inquisitorDecisionsEnabled = (row: InquisitorItem): boolean[] => [
    ...browsingLevels.map(() => !row.hasBlockMarker),
    true,
  ];

  // The Knights' own list, as a Knight's Blocked vote picks from it.
  const BLOCK_REASONS: ResolutionReason[] = KNIGHTS_BLOCK_REASONS.map((r) => ({
    value: r.value,
    label: r.label,
    description: r.label,
  }));
  // No Knights reason requires a note (`reasonRequiresNote` matches only 'other'), so the picker gets none.
  const blockReasonLabel = (value: string) =>
    BLOCK_REASONS.find((r) => r.value === value)?.label ?? value;
</script>

<script lang="ts">
  import { IconExternalLink } from '@tabler/icons-svelte';
  import { enhance } from '$app/forms';
  import type { SubmitFunction } from '@sveltejs/kit';
  import { getBrowsingLevelLabel } from '@civitai/shared';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
  } from '@civitai/ui/components/ui/table/index.js';
  import EdgeMedia from '$lib/components/EdgeMedia.svelte';
  import ReasonPicker from '$lib/components/triage/ReasonPicker.svelte';
  import TriageCard from '$lib/components/triage/TriageCard.svelte';
  import TriageColumns from '$lib/components/triage/TriageColumns.svelte';
  import TriageDecisionBar from '$lib/components/triage/TriageDecisionBar.svelte';
  import TriageDetailHeader from '$lib/components/triage/TriageDetailHeader.svelte';
  import TriageKeyButton from '$lib/components/triage/TriageKeyButton.svelte';
  import { imageLookupUrl } from '$lib/entity-url';
  import { LINK_BUTTON, dateTime, num, shortAge } from '$lib/format';
  import type { Outcome } from '$lib/triage/queue';
  import InquisitorChips from './InquisitorChips.svelte';
  import {
    closeReasonPickerBeyond,
    openReasonPicker,
    reasonPicker,
    resetReasonPicker,
  } from '$lib/triage/reason-picker.svelte';

  let {
    row,
    verdict,
    error,
    submit,
    actionHref,
  }: {
    row: InquisitorItem;
    verdict: string | undefined;
    error: string | undefined;
    submit: (outcome: Outcome) => SubmitFunction;
    actionHref: (action: string) => string;
  } = $props();

  // The reason the picker last chose; posted only with Blocked.
  let blockReason = $state('');
  $effect(() => () => resetReasonPicker());
  $effect(() => closeReasonPickerBeyond(DECISION_COUNT));

  const topVote = $derived(row.votes[0]?.answer);

  const decide: SubmitFunction = (input) => {
    const level = Number(input.formData.get('level'));
    if (level === NsfwLevel.Blocked && !blockReason) {
      input.cancel();
      openReasonPicker(BLOCKED_INDEX);
      return;
    }
    if (level !== NsfwLevel.Blocked) input.formData.delete('blockReason');
    resetReasonPicker();
    const finish = submit(
      level === NsfwLevel.Blocked
        ? `Blocked: ${blockReasonLabel(blockReason)}`
        : `Rated ${getBrowsingLevelLabel(level)}`
    )(input);
    // A refused Blocked asks for its reason again, by mouse as by key.
    return async (opts) => {
      if (opts.result.type !== 'success') blockReason = '';
      await (await finish)?.(opts);
    };
  };
</script>

{#snippet buttons()}
  {#each browsingLevels as level, i (level)}
    <TriageKeyButton
      type="submit"
      key={i + 1}
      name="level"
      value={level}
      tone={String(level) === topVote ? 'blue' : undefined}
      disabled={!inquisitorDecisionsEnabled(row)[i]}
    >
      {getBrowsingLevelLabel(level)}
      {#if level === row.currentLevel}
        <span class="text-[11px] font-normal text-dark-2">current</span>
      {/if}
    </TriageKeyButton>
  {/each}
  <TriageKeyButton
    type="submit"
    key={DECISION_COUNT}
    reasons
    tone="red-outline"
    name="level"
    value={NsfwLevel.Blocked}
  >
    Blocked
  </TriageKeyButton>
{/snippet}

{#snippet picker()}
  <ReasonPicker
    index={BLOCKED_INDEX}
    label="Blocked"
    reasons={BLOCK_REASONS}
    current={blockReason || (row.blockReason?.reason ?? '')}
    note=""
    onreason={(next) => (blockReason = next)}
    onneednote={() => undefined}
  />
{/snippet}

<TriageColumns {verdict} {error}>
  {#snippet header()}
    <div class="space-y-2">
      <TriageDetailHeader title="Image #{row.imageId}" reference="item {row.id}" linksBeside>
        {#snippet chips()}<InquisitorChips {row} detailed />{/snippet}
        {#snippet links()}
          <Button variant="outline" size="sm" class={LINK_BUTTON} href={imageLookupUrl(row.imageId)}>
            <IconExternalLink aria-hidden="true" /> Image lookup
          </Button>
        {/snippet}
      </TriageDetailHeader>
      <p class="m-0 text-sm text-dark-2">
        from {row.source} · queued
        <span title={dateTime(row.createdAt)}>{shortAge(row.createdAt)} ago</span>
      </p>
    </div>
  {/snippet}

  {#snippet evidence()}
    <EdgeMedia
      src={row.imageKey}
      name={row.imageName}
      type={row.imageType === 'video' ? 'video' : 'image'}
      width={900}
      alt="Image {row.imageId}"
      class="mx-auto max-h-[75svh] w-auto rounded-md object-contain"
    />
  {/snippet}

  {#snippet info()}
    <TriageCard title="Knights voted" dense>
      {#if row.votes.length === 0}
        <p class="m-0 text-dark-2">No votes were cast.</p>
      {:else}
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Answer</TableHead>
              <TableHead class="text-right">Votes</TableHead>
              <TableHead>By stage</TableHead>
              <TableHead class="text-right">Weight</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {#each row.votes as vote (vote.answer)}
              <TableRow>
                <TableCell>{vote.label}</TableCell>
                <TableCell class="text-right">{num(vote.votes)}</TableCell>
                <TableCell class="text-dark-2">
                  {vote.stages.map((s) => `${s.stage} ${num(s.votes)}`).join(' · ')}
                </TableCell>
                <TableCell class="text-right">
                  {vote.weight.toLocaleString(undefined, { maximumFractionDigits: 1 })}
                </TableCell>
              </TableRow>
            {/each}
          </TableBody>
        </Table>
      {/if}
      {#if row.blockReason}
        <p class="m-0 mt-2 text-dark-2">
          Blocked · {row.blockReason.label} ({row.blockReason.count} of {row.blockReason.of})
        </p>
      {/if}
    </TriageCard>

    <TriageCard title="Question" dense>
      <p class="m-0 text-dark-0">{row.prompt}</p>
    </TriageCard>

    {#if row.hasBlockMarker}
      <TriageCard title="Blocked image" dense accent="amber">
        <p class="m-0 text-dark-0">
          Rating it does not unblock it, so only Blocked is offered. To rate it, restore it from the
          image queue first.
        </p>
      </TriageCard>
    {/if}
  {/snippet}

  {#snippet decision()}
    <form method="POST" action={actionHref('rule')} use:enhance={decide} class="w-full">
      <input type="hidden" name="itemId" value={row.id} />
      {#if blockReason}<input type="hidden" name="blockReason" value={blockReason} />{/if}
      <TriageDecisionBar
        compact
        {buttons}
        picker={reasonPicker.open === BLOCKED_INDEX ? picker : undefined}
        hint="Blue is the Knights' top vote. Blocked asks for a reason (1 to {BLOCK_REASONS.length}); Esc cancels."
      />
    </form>
  {/snippet}
</TriageColumns>
