<script lang="ts">
  import TrainingAssetViewer from '$lib/components/TrainingAssetViewer.svelte';
  import WorkflowDataset from '$lib/components/WorkflowDataset.svelte';
  import { LINK_CLASS } from '$lib/format';
  import { userLookupUrl, modelVersionUrl } from '$lib/entity-url';
  import ReviewActions from './ReviewActions.svelte';
  import TrainingProvenance from './TrainingProvenance.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  const detail = $derived(data.detail);
  const results = $derived(detail.trainingResults);
</script>

<header class="page-header">
  <h1>{detail.modelName} — {detail.versionName}</h1>
  <p>
    Uploaded by
    <a href={userLookupUrl(detail.username ?? detail.userId)} class={LINK_CLASS}>
      {detail.username ?? `#${detail.userId}`}
    </a>
  </p>
  <TrainingProvenance versionId={detail.versionId} />
</header>

{#key detail.versionId}
  <ReviewActions
    modelHref={modelVersionUrl(data.civitaiUrl, detail.modelId, detail.versionId)}
    csamContents={data.csamContents}
    canReportCsam={!!data.grants['csam.report.file']}
  />
{/key}

<dl class="mb-5 grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
  <div><dt class="text-xs text-dark-2">Workflow ID</dt><dd>{detail.workflowId ?? 'N/A'}</dd></div>
  {#if !detail.workflowId}
    <div><dt class="text-xs text-dark-2">Job ID</dt><dd>{detail.jobId ?? 'N/A'}</dd></div>
  {/if}
  <div><dt class="text-xs text-dark-2">Version</dt><dd>{results.version ?? '1'}</dd></div>
  <div><dt class="text-xs text-dark-2">Started</dt><dd>{results.startedAt ?? 'N/A'}</dd></div>
  <div><dt class="text-xs text-dark-2">Submitted</dt><dd>{results.submittedAt ?? 'N/A'}</dd></div>
  <div><dt class="text-xs text-dark-2">Completed</dt><dd>{results.completedAt ?? 'N/A'}</dd></div>
</dl>

{#if detail.studioWorkflowId}
  <h2 class="mb-2 text-lg font-semibold text-white">Dataset</h2>
  {#await data.studioDataset}
    <p class="text-sm text-dark-2">Reading the dataset from the training workflow…</p>
  {:then loaded}
    {#if loaded?.ok}
      {#if loaded.dataset.kind === 'blobs'}
        <WorkflowDataset
          workflowId={loaded.workflowId}
          items={loaded.dataset.items}
          itemStates={data.studioItemStates}
        />
      {:else}
        <p class="text-sm text-dark-2">
          This run's dataset is in a shape this page cannot preview.
        </p>
      {/if}
    {:else if loaded}
      <p class="text-sm text-amber-200">Could not read the dataset: {loaded.error}</p>
    {/if}
  {:catch}
    <p class="text-sm text-amber-200">Could not read the dataset from the training workflow.</p>
  {/await}
{:else}
  <TrainingAssetViewer
    versionId={detail.versionId}
    columns="grid-cols-2 sm:grid-cols-3 lg:grid-cols-5"
  />
{/if}
