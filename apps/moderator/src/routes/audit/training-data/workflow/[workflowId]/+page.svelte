<script lang="ts">
  import { LINK_CLASS, dateTime, relativeTime } from '$lib/format';
  import { csamReportUrl, userLookupUrl } from '$lib/entity-url';
  import { gateExpiresSoon, hasViewableItem, workflowOriginLabel } from '$lib/training-workflow';
  import WorkflowDataset from './WorkflowDataset.svelte';
  import WorkflowReviewActions from './WorkflowReviewActions.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  const detail = $derived(data.detail);
  const expiringSoon = $derived(gateExpiresSoon(detail.expiresAt));
  const reviewable = $derived(detail.underReview && detail.modelVersionId === null);
  const viewable = $derived(data.itemStates.then(hasViewableItem));
</script>

<header class="page-header">
  <h1>Workflow-only training run</h1>
  <p>
    Requested by
    <a href={userLookupUrl(detail.username ?? detail.ownerId)} class={LINK_CLASS}>
      {detail.username ?? `#${detail.ownerId}`}
    </a>
    · {workflowOriginLabel(detail.origin)}
  </p>
</header>

<dl class="mb-5 grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
  <div>
    <dt class="text-xs text-dark-2">Workflow ID</dt>
    <dd class="break-all text-dark-0">{detail.workflowId}</dd>
  </div>
  <div>
    <dt class="text-xs text-dark-2">Submitted</dt>
    <dd class="text-dark-0">{dateTime(detail.submittedAt)}</dd>
  </div>
  <div><dt class="text-xs text-dark-2">Step</dt><dd class="text-dark-0">{detail.stepType}</dd></div>
  <div>
    <dt class="text-xs text-dark-2">Workflow status</dt>
    <dd class="text-dark-0">{detail.status ?? 'N/A'}</dd>
  </div>
  <div>
    <dt class="text-xs text-dark-2">Moderation</dt>
    <dd class="text-dark-0">{detail.moderationStatus ?? 'N/A'}</dd>
  </div>
  {#if detail.underReview}
    <div>
      <dt class="text-xs text-dark-2">Gate expires (approx.)</dt>
      <dd class={expiringSoon ? 'text-amber-200' : 'text-dark-0'}>
        {relativeTime(detail.expiresAt)} · {dateTime(detail.expiresAt)}
      </dd>
    </div>
  {/if}
</dl>

{#if detail.modelVersionId !== null}
  <p class="mb-4 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-200">
    This run belongs to model version {detail.modelVersionId} and is reviewed there, which also
    updates the version:
    <a href="/audit/training-data/{detail.modelVersionId}" class={LINK_CLASS}>
      review model version {detail.modelVersionId}
    </a>.
  </p>
{:else if detail.versionClaimUnconfirmed}
  <p class="mb-4 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-200">
    This run carries a model-version tag that is unreadable, or names a version whose review would
    not release this run, so it is treated as a workflow-only run.
  </p>
{/if}
{#if detail.modelVersionId === null && !detail.underReview}
  <p class="mb-4 text-sm text-dark-2">
    This run is not awaiting review (moderation: {detail.moderationStatus ?? 'none'}).
  </p>
{/if}

{#if reviewable}
  {#key detail.workflowId}
    <WorkflowReviewActions
      expiresAt={detail.expiresAt}
      {expiringSoon}
      {viewable}
    />
  {/key}
{/if}

{#if detail.modelVersionId === null && (reviewable || detail.moderationStatus === 'rejected')}
  <!-- There is no workflow-keyed CSAM report: the existing one files against a model version. The
       account-level report on the main site is the path for these runs; deny first so the run cannot
       proceed while the report is filed. -->
  <p class="mb-5 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-200">
    CSAM in this dataset: <strong>deny</strong> the run, then file an account report on the main site
    —
    <a
      href={csamReportUrl(data.civitaiUrl, detail.ownerId)}
      target="_blank"
      rel="noreferrer"
      class={LINK_CLASS}
    >
      report user #{detail.ownerId} ↗
    </a>. That report covers the account; it does not attach these dataset items, so note the
    workflow id ({detail.workflowId}) in it.
  </p>
{/if}

<h2 class="mb-2 text-lg font-semibold text-white">Dataset</h2>
{#if detail.dataset.kind === 'blobs'}
  <WorkflowDataset
    workflowId={detail.workflowId}
    items={detail.dataset.items}
    itemStates={data.itemStates}
  />
{:else if detail.dataset.kind === 'archive'}
  <p class="text-sm text-dark-2">
    This run's dataset is a packaged archive{detail.dataset.count != null
      ? ` of ${detail.dataset.count} items`
      : ''}, which cannot be previewed here.
  </p>
{:else}
  <p class="text-sm text-dark-2">This run's dataset is in a shape this page does not recognise.</p>
{/if}
