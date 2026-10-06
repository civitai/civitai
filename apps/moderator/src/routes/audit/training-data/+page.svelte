<script lang="ts">
  import { page } from '$app/state';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { dateTime, relativeTime } from '$lib/format';
  import { gateExpiresSoon, workflowOriginLabel } from '$lib/training-workflow';
  import { urlWith } from '$lib/url';
  import CursorPager from '$lib/components/CursorPager.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
</script>

<header class="page-header">
  <h1>Training Data Review</h1>
  <p>Training runs the orchestrator paused for a moderator to approve or deny the dataset.</p>
</header>

{#if data.workflowFilterUnavailable}
  <p class="mb-4 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-200">
    The orchestrator is unreachable, so this list is unfiltered — some rows may have no workflow left
    and will refuse to approve.
  </p>
{/if}

{#if data.items.length === 0}
  <!-- Rows are dropped AFTER the page limit, so an empty page does not mean an empty queue. -->
  <p class="text-sm text-dark-2">
    {data.nextCursor
      ? 'Nothing reviewable on this page — every row here has no live workflow. Continue to the next page.'
      : 'Nothing waiting for review.'}
  </p>
{:else}
  <ul class="flex flex-col gap-3">
    {#each data.items as item (item.id)}
      <li
        class="flex items-center justify-between gap-3 rounded-xl border border-dark-4 bg-dark-6 p-4"
      >
        <div class="min-w-0">
          <p class="truncate text-sm text-dark-0">{item.modelName} — {item.name}</p>
          <p class="text-xs text-dark-2">Created {dateTime(item.createdAt)}</p>
          <p class="text-xs text-dark-2">Workflow: {item.workflowId ?? 'none'}</p>
        </div>
        <Button size="sm" href="/audit/training-data/{item.id}">Review</Button>
      </li>
    {/each}
  </ul>
{/if}

<CursorPager href={data.nextCursor ? urlWith(page.url, { cursor: data.nextCursor }) : null} />

{#if data.workflowGates}
  <section class="mt-8">
    <h2 class="mb-1 text-lg text-dark-0">Workflow-only runs</h2>
    <p class="mb-3 text-sm text-dark-2">
      Training Studio and App Block runs held for review. They have no model version, so they are
      reviewed by workflow. Found through the Buzz ledger, so a run submitted at no charge does not
      appear, and a just-submitted run can take a few minutes to show up.
    </p>

    {#await data.workflowGates}
      <p class="text-sm text-dark-2">Checking recent training runs with the orchestrator…</p>
    {:then gates}
      {#if gates.ledgerUnavailable}
        <p class="rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200">
          The training charge ledger could not be read, so this list could not be built. That is not
          the same as nothing waiting — reload to try again.
        </p>
      {:else}
        {#if gates.workflowFilterUnavailable}
          <p
            class="mb-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-200"
          >
            The orchestrator could not be asked about some runs, so they are listed unchecked — they
            may already be finished and will refuse a ruling.
          </p>
        {/if}
        {#if gates.truncated}
          <p class="mb-3 text-sm text-amber-200">
            More candidates than one load checks — only the newest were checked.
          </p>
        {/if}
        {#if gates.items.length === 0}
          <p class="text-sm text-dark-2">No workflow-only run is waiting for review.</p>
        {:else}
          <ul class="flex flex-col gap-3">
            {#each gates.items as item (item.workflowId)}
              <li
                class="flex items-center justify-between gap-3 rounded-xl border border-dark-4 bg-dark-6 p-4"
              >
                <div class="min-w-0">
                  <p class="truncate text-sm text-dark-0">
                    {item.username ?? `#${item.ownerId}`} — {workflowOriginLabel(item.origin)}
                    {#if !item.verified}<span class="text-amber-200"> · unchecked</span>{/if}
                  </p>
                  <p class="text-xs text-dark-2">Submitted {dateTime(item.submittedAt)}</p>
                  {#if item.expiresAt}
                    <p
                      class="text-xs {gateExpiresSoon(item.expiresAt)
                        ? 'text-amber-200'
                        : 'text-dark-2'}"
                    >
                      Gate expires {relativeTime(item.expiresAt)}
                    </p>
                  {/if}
                  <p class="truncate text-xs text-dark-2">Workflow: {item.workflowId}</p>
                </div>
                <Button
                  size="sm"
                  href="/audit/training-data/workflow/{encodeURIComponent(item.workflowId)}"
                >
                  Review
                </Button>
              </li>
            {/each}
          </ul>
        {/if}
      {/if}
    {:catch}
      <p class="rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200">
        Workflow-only runs could not be loaded. That is not the same as nothing waiting — reload to try
        again.
      </p>
    {/await}
  </section>
{/if}
