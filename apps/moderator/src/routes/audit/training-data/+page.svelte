<script lang="ts">
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { dateTime } from '$lib/format';
  import WorkflowGateQueue from './WorkflowGateQueue.svelte';
  import type { PageData } from './$types';
  import type { TrainingReviewRow } from '$lib/server/training-moderation.service';

  let { data }: { data: PageData } = $props();

  const underReview = $derived(
    data.items.filter((item: TrainingReviewRow) => item.underReview).length
  );
  const partial = $derived(data.workflowFilterUnavailable || data.truncated);
</script>

<header class="page-header">
  <h1>Training Data Review</h1>
  <p>Training runs the orchestrator paused for a moderator to approve or deny the dataset.</p>
  <p class="text-sm text-dark-2">
    {partial ? 'At least ' : ''}{underReview.toLocaleString()} model
    {underReview === 1 ? 'version' : 'versions'} under review.
    Under review first, then the other paused versions; oldest first within each.
  </p>
</header>

{#if data.workflowFilterUnavailable}
  <p class="mb-4 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-200">
    Some workflows could not be read from the orchestrator, so those rows are listed unchecked — they
    may have no workflow left, or be under review, and are sorted with the rest.
  </p>
{/if}
{#if data.truncated}
  <p class="mb-4 text-sm text-amber-200">
    More paused versions than one load checks — the oldest were not checked.
  </p>
{/if}

{#if data.items.length === 0}
  <p class="text-sm text-dark-2">
    {data.truncated
      ? 'Nothing live among the paused versions checked — the oldest were not checked.'
      : 'Nothing waiting for review.'}
  </p>
{:else}
  <ul class="flex flex-col gap-3">
    {#each data.items as item (item.id)}
      <li
        class="flex items-center justify-between gap-3 rounded-xl border border-dark-4 bg-dark-6 p-4"
      >
        <div class="min-w-0">
          <p class="flex items-center gap-2 text-sm text-dark-0">
            <span class="truncate">{item.modelName} — {item.name}</span>
            {#if item.underReview}
              <Badge variant="secondary">Under review</Badge>
            {:else if !item.checked}
              <Badge variant="outline">Unchecked</Badge>
            {/if}
          </p>
          <p class="text-xs text-dark-2">Created {dateTime(item.createdAt)}</p>
          <p class="text-xs text-dark-2">Workflow: {item.workflowId ?? 'none'}</p>
        </div>
        <Button size="sm" href="/audit/training-data/{item.id}">Review</Button>
      </li>
    {/each}
  </ul>
{/if}

<WorkflowGateQueue gates={data.workflowGates} />
