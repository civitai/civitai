<script lang="ts">
  import type { SubmitFunction } from '@sveltejs/kit';
  import { enhance } from '$app/forms';
  import MetaChip from '$lib/components/minor-flags/MetaChip.svelte';
  import ModelDetailHeader from '$lib/components/minor-flags/ModelDetailHeader.svelte';
  import ModelFactsCard from '$lib/components/minor-flags/ModelFactsCard.svelte';
  import PreviewImagesCard from '$lib/components/minor-flags/PreviewImagesCard.svelte';
  import SharedFileCard from '$lib/components/minor-flags/SharedFileCard.svelte';
  import UploaderCard from '$lib/components/minor-flags/UploaderCard.svelte';
  import TriageCard from '$lib/components/triage/TriageCard.svelte';
  import TriageDecisionBar from '$lib/components/triage/TriageDecisionBar.svelte';
  import TriageDetailFrame from '$lib/components/triage/TriageDetailFrame.svelte';
  import TriageKeyButton from '$lib/components/triage/TriageKeyButton.svelte';
  import { dateTime } from '$lib/format';
  import { ago, modelUrl } from '$lib/minor-flags/appeal-row';
  import type { MinorHashReviewRow } from '$lib/server/minor-hash.service';
  import type { Outcome } from '$lib/triage/queue';

  let {
    row,
    civitaiUrl,
    verdict,
    error,
    submit,
    actionHref,
    formActions,
  }: {
    row: MinorHashReviewRow;
    civitaiUrl: string;
    verdict: string | undefined;
    error: string | undefined;
    submit: (outcome: Outcome) => SubmitFunction;
    actionHref: (action: string) => string;
    /** The action of each decision form, in key order. */
    formActions: readonly [string, string];
  } = $props();

  const DECISIONS = [
    { label: 'Flag as minor', outcome: 'Flagged as minor' },
    { label: 'Dismiss match', outcome: 'Dismissed' },
  ] as const;
</script>

<TriageDetailFrame {verdict} {error}>
  {#snippet children()}
    <ModelDetailHeader
      modelId={row.modelId}
      modelName={row.modelName}
      userId={row.userId}
      {civitaiUrl}
    >
      {#snippet chips()}
        <MetaChip size="md">file match</MetaChip>
        <MetaChip size="md" tone="green">not flagged</MetaChip>
        <MetaChip size="md" tone="amber">different uploader</MetaChip>
      {/snippet}
    </ModelDetailHeader>

    <PreviewImagesCard images={row.coverImages} allHref={modelUrl(civitaiUrl, row.modelId)} />

    <div class="grid gap-4 lg:grid-cols-2">
      <TriageCard title="Why it is here">
        <div class="space-y-2 text-base text-dark-0">
          <p class="m-0">
            Its main file is byte-identical to a file in a model a moderator flagged as minor. The
            uploader is a different account, so nothing was applied automatically. Decide whether
            this upload is the same content under a new name.
          </p>
          <p class="m-0 text-sm text-dark-2" title={dateTime(row.createdAt)}>
            uploaded {ago(row.createdAt)}
          </p>
        </div>
      </TriageCard>
      <SharedFileCard {row} {civitaiUrl} />
    </div>

    <div class="grid gap-4 md:grid-cols-2">
      <ModelFactsCard {row} />
      <UploaderCard {row} />
    </div>
  {/snippet}
  {#snippet actions()}
    <!-- No reason form: the main app's set-minor and dismiss endpoints take the model id only. -->
    <TriageDecisionBar>
      {#snippet buttons()}
        {#each DECISIONS as choice, i (choice.label)}
          <form
            method="POST"
            action={actionHref(formActions[i])}
            data-triage-action={formActions[i]}
            use:enhance={submit(choice.outcome)}
          >
            <input type="hidden" name="modelId" value={row.modelId} />
            <TriageKeyButton type="submit" key={i + 1} primary={i === 0}>
              {choice.label}
            </TriageKeyButton>
          </form>
        {/each}
      {/snippet}
    </TriageDecisionBar>
  {/snippet}
</TriageDetailFrame>
