<script lang="ts">
  import { enhance } from '$app/forms';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Label } from '@civitai/ui/components/ui/label/index.js';
  import { Textarea } from '@civitai/ui/components/ui/textarea/index.js';
  import { toast } from '@civitai/ui/components/ui/sonner/index.js';
  import { FormState } from '$lib/form-state.svelte';
  import { LINK_CLASS, dateTime, relativeTime } from '$lib/format';
  import { userLookupUrl } from '$lib/entity-url';
  import { gateExpiresSoon, workflowOriginLabel } from '$lib/training-workflow';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  const detail = $derived(data.detail);
  const blobUrl = (index: number) =>
    `/api/training-workflow-blob/${encodeURIComponent(detail.workflowId)}/${index}`;
  const expiringSoon = $derived(gateExpiresSoon(detail.expiresAt));
  const reviewable = $derived(detail.underReview && detail.modelVersionId === null);

  // One FormState for both verdicts: one place for a refusal, and only one can be in flight. `reload`
  // re-reads the run, so the page shows the orchestrator's state after the ruling rather than ours.
  let verdict = $state('');
  const form = new FormState({
    reload: true,
    onSubmit: ({ action }) =>
      (verdict = action.search === '?/approve' ? 'Training run approved' : 'Training run denied'),
    onSuccess: () => {
      if (verdict) toast.success(verdict);
    },
  });
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
  <div><dt class="text-xs text-dark-2">Workflow ID</dt><dd class="break-all">{detail.workflowId}</dd></div>
  <div><dt class="text-xs text-dark-2">Submitted</dt><dd>{dateTime(detail.submittedAt)}</dd></div>
  <div><dt class="text-xs text-dark-2">Step</dt><dd>{detail.stepType}</dd></div>
  <div><dt class="text-xs text-dark-2">Workflow status</dt><dd>{detail.status ?? 'N/A'}</dd></div>
  <div>
    <dt class="text-xs text-dark-2">Moderation</dt>
    <dd>{detail.moderationStatus ?? 'N/A'}</dd>
  </div>
  {#if detail.underReview && detail.expiresAt}
    <div>
      <dt class="text-xs text-dark-2">Gate expires (approx.)</dt>
      <dd class={expiringSoon ? 'text-amber-200' : ''}>
        {relativeTime(detail.expiresAt)} · {dateTime(detail.expiresAt)}
      </dd>
    </div>
  {/if}
</dl>

{#if detail.modelVersionId !== null}
  <p class="mb-4 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-200">
    {#if detail.modelVersionId > 0}
      This run belongs to a model version and is reviewed there, which also updates the version:
      <a href="/audit/training-data/{detail.modelVersionId}" class={LINK_CLASS}>
        review model version {detail.modelVersionId}
      </a>.
    {:else}
      This run carries a model-version tag that could not be read, so it cannot be ruled on here.
      Escalate it.
    {/if}
  </p>
{:else if !detail.underReview}
  <p class="mb-4 text-sm text-dark-2">
    This run is not awaiting review (moderation: {detail.moderationStatus ?? 'none'}).
  </p>
{/if}

{#if reviewable}
  {#if expiringSoon}
    <p class="mb-3 text-sm text-amber-200">
      The gate expires {relativeTime(detail.expiresAt)}. If it expires the run is cancelled and
      refunded.
    </p>
  {/if}
  <div class="mb-4 flex flex-wrap items-start gap-4">
    <form method="POST" action="?/approve" use:enhance={form.enhance}>
      <Button type="submit" size="sm" disabled={form.submitting}>Approve</Button>
    </form>
    <form method="POST" action="?/deny" use:enhance={form.enhance} class="flex flex-col gap-2">
      <Label for="deny-reason" class="text-xs text-dark-2">Reason (optional, shown to the user)</Label>
      <Textarea id="deny-reason" name="reason" rows={2} maxlength={1000} class="w-80 max-w-full" />
      <Button
        type="submit"
        size="sm"
        variant="destructive"
        disabled={form.submitting}
        class="self-start"
      >
        Deny
      </Button>
    </form>
  </div>
  <p class="mb-4 text-xs text-dark-2">
    Deny cancels the run and the orchestrator refunds it in full. Neither ruling can be undone here.
  </p>
{/if}

{#if form.error}
  <p class="mb-4 text-sm text-red-300">{form.error}</p>
{/if}

{#if detail.modelVersionId === null && (reviewable || detail.moderationStatus === 'rejected')}
  <!-- There is no workflow-keyed CSAM report: the existing one files against a model version. The
       account-level report on the main site is the path for these runs; deny first so the run cannot
       proceed while the report is filed. -->
  <p class="mb-5 rounded-md border border-dark-4 bg-dark-6 p-3 text-sm text-dark-1">
    CSAM in this dataset: <strong>deny</strong> the run, then file an account report on the main site
    —
    <a
      href="{data.civitaiUrl}/moderator/csam/{detail.ownerId}"
      target="_blank"
      rel="noreferrer"
      class={LINK_CLASS}
    >
      report user #{detail.ownerId} ↗
    </a>. That report covers the account; it does not attach these dataset items, so note the
    workflow id ({detail.workflowId}) in it.
  </p>
{/if}

<h2 class="mb-2 text-lg text-dark-0">Dataset</h2>
{#if detail.dataset.kind === 'blobs'}
  <p class="mb-3 text-xs text-dark-2">
    {detail.dataset.items.length} items. An item withheld when it was uploaded may show as a
    placeholder.
  </p>
  <ul class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
    {#each detail.dataset.items as item (item.index)}
      <li class="flex flex-col gap-1 rounded-lg border border-dark-4 bg-dark-6 p-2">
        {#if !item.blobKey}
          <p class="text-xs text-dark-2">Item {item.index + 1}: not a stored upload.</p>
        {:else if item.media === 'image'}
          <a href={blobUrl(item.index)} target="_blank" rel="noreferrer">
            <img
              src={blobUrl(item.index)}
              alt="Dataset item {item.index + 1}"
              loading="lazy"
              class="aspect-square w-full rounded object-contain"
            />
          </a>
        {:else if item.media === 'video'}
          <!-- svelte-ignore a11y_media_has_caption -->
          <video src={blobUrl(item.index)} controls preload="none" class="w-full rounded"></video>
        {:else if item.media === 'audio'}
          <audio src={blobUrl(item.index)} controls preload="none" class="w-full"></audio>
        {:else}
          <a href={blobUrl(item.index)} class="text-xs {LINK_CLASS}">Item {item.index + 1}</a>
        {/if}
        <p class="text-xs break-words whitespace-pre-wrap text-dark-1">
          {item.caption ?? '(no caption)'}
        </p>
      </li>
    {/each}
  </ul>
{:else if detail.dataset.kind === 'archive'}
  <p class="text-sm text-dark-2">
    This run's dataset is a packaged archive{detail.dataset.count != null
      ? ` of ${detail.dataset.count} items`
      : ''}, which cannot be previewed here.
  </p>
{:else}
  <p class="text-sm text-dark-2">This run's dataset is in a shape this page does not recognise.</p>
{/if}
