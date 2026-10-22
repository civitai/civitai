<script lang="ts">
  import type { ComponentProps, Snippet } from 'svelte';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';
  import ModelPreview from '$lib/components/ModelPreview.svelte';
  import ModelDetailHeader from '$lib/components/minor-flags/ModelDetailHeader.svelte';
  import ModelFactsCard from '$lib/components/minor-flags/ModelFactsCard.svelte';
  import UploaderCard from '$lib/components/minor-flags/UploaderCard.svelte';
  import ReportDetailColumns from '$lib/components/report-queue/ReportDetailColumns.svelte';
  import type { ModelFlagDetail } from '$lib/minor-flags/model-detail';

  /**
   * Every Model Flags tab's open item, laid out as the model report queue's: the model's header over
   * `ModelPreview`, the tab's own reading of the flag, the uploader and the model's facts in the
   * sidebar, and its decision pinned underneath.
   */
  let {
    row,
    detail,
    civitaiUrl,
    canViewTrainingData,
    verdict,
    error,
    chips,
    info,
    decision,
  }: {
    row: ComponentProps<typeof UploaderCard>['row'] &
      ComponentProps<typeof ModelFactsCard>['row'] & { modelId: number; modelName: string };
    /** The tab's `modelFlagDetail` request. */
    detail: Promise<ModelFlagDetail>;
    civitaiUrl: string;
    canViewTrainingData: boolean;
    /** The outcome already chosen for this item, shown in place of the decision. */
    verdict: string | undefined;
    error: string | undefined;
    /** The tab's status chips under the model's name. */
    chips: Snippet;
    /** The tab's own sidebar cards: why it is here and its history. */
    info: Snippet;
    decision: Snippet;
  } = $props();
</script>

<div class="flex min-h-0 flex-1 flex-col overflow-y-auto xl:overflow-hidden">
  <ReportDetailColumns>
    {#snippet header()}
      <ModelDetailHeader
        modelId={row.modelId}
        modelName={row.modelName}
        userId={row.userId}
        {civitaiUrl}
        {detail}
        {chips}
      />
    {/snippet}

    {#snippet evidence()}
      <!-- Keyed so an open lightbox or training-data sheet cannot carry over to the next model. -->
      {#key row.modelId}
        <ModelPreview modelId={row.modelId} reportId={null} {civitaiUrl} {canViewTrainingData} />
      {/key}
    {/snippet}

    {#snippet actions()}
      {@render info()}
      <UploaderCard {row} {detail} />
      <ModelFactsCard {row} {detail} />
    {/snippet}

    <!-- `data-triage-actions` is where `TriageShell` puts focus after a refusal. -->
    {#snippet footer()}
      {#if error}<ErrorAlert class="mb-3" message={error} />{/if}
      <div data-triage-actions class="flex flex-col gap-2">
        <!-- No whitespace inside: `empty:` must match while there is no verdict. -->
        <div role="status" class="text-base font-medium text-white empty:sr-only">{#if verdict}{verdict}{/if}</div>
        {#if !verdict}{@render decision()}{/if}
      </div>
    {/snippet}
  </ReportDetailColumns>
</div>
