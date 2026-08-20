<script lang="ts">
  import { page } from '$app/state';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { dateTime } from '$lib/format';
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
