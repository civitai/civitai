<script lang="ts">
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { dateTime, relativeTime } from '$lib/format';
  import { trainingWorkflowReviewUrl } from '$lib/entity-url';
  import { gateExpiresSoon, workflowOriginLabel } from '$lib/training-workflow';
  import type { PendingWorkflowGates } from '$lib/server/training-moderation.service';

  let { gates }: { gates: Promise<PendingWorkflowGates> } = $props();
</script>

<section class="mt-8">
  <h2 class="mb-1 text-lg font-semibold text-white">Workflow-only runs</h2>
  <p class="mb-3 text-sm text-dark-2">
    Training Studio and App Block runs held for review. They have no model version, so they are
    reviewed by workflow. Oldest first — the oldest is closest to expiring. Found through the Buzz
    ledger, so a run submitted at no charge does not appear, and a just-submitted run can take a few
    minutes to show up.
  </p>

  {#await gates}
    <p class="text-sm text-dark-2">Checking recent training runs with the orchestrator…</p>
  {:then result}
    {#if result.ledgerUnavailable}
      <p class="rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200">
        The training charge ledger could not be read, so this list could not be built. That is not
        the same as nothing waiting — reload to try again.
      </p>
    {:else}
      {#if result.workflowFilterUnavailable}
        <p
          class="mb-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-200"
        >
          Some runs could not be fully checked, so they are listed unchecked — they may already be
          finished or belong to a model version, and will refuse a ruling if so.
        </p>
      {/if}
      {#if result.truncated}
        <p class="mb-3 text-sm text-amber-200">
          More candidates than one load checks — the newest were not checked yet.
        </p>
      {/if}
      {#if result.items.length === 0}
        <p class="text-sm text-dark-2">No workflow-only run is waiting for review.</p>
      {:else}
        <ul class="flex flex-col gap-3">
          {#each result.items as item (item.workflowId)}
            <li
              class="flex items-center justify-between gap-3 rounded-xl border border-dark-4 bg-dark-6 p-4"
            >
              <div class="min-w-0">
                <p class="truncate text-sm text-dark-0">
                  {item.username ?? `#${item.ownerId}`} — {workflowOriginLabel(item.origin)}
                  {#if !item.verified}<span class="text-amber-200"> · unchecked</span>{/if}
                  {#if item.versionClaimUnconfirmed}
                    <span class="text-amber-200"> · unconfirmed model-version tag</span>
                  {/if}
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
              <Button size="sm" href={trainingWorkflowReviewUrl(item.workflowId)}>Review</Button>
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
