<script lang="ts">
  import type { Snippet } from 'svelte';
  import { IconClockPause, IconExternalLink, IconInfoCircle } from '@tabler/icons-svelte';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import {
    TRAINING_REVIEW_COPY as copy,
    canRaiseTrainingReview,
  } from '@civitai/shared/training-review';
  import { browser, hostConfig } from '$lib/host';

  let {
    kind,
    workflowId,
    heldSince,
    children,
  }: {
    kind: 'review' | 'rejected' | 'unreviewed';
    workflowId: string;
    heldSince?: string;
    /** Extra actions under the message (e.g. reuse the dataset). */
    children?: Snippet;
  } = $props();

  // Re-read the clock once a minute so a page left open offers the raise when the threshold passes.
  let now = $state(new Date());
  $effect(() => {
    if (!browser || kind !== 'review') return;
    const timer = setInterval(() => (now = new Date()), 60_000);
    return () => clearInterval(timer);
  });

  const canRaise = $derived(
    kind === 'review' && canRaiseTrainingReview(heldSince, now)
  );
  const supportUrl = $derived(hostConfig().supportUrl);

  const text = $derived(
    kind === 'review'
      ? { title: copy.pendingTitle, body: copy.pendingBody }
      : kind === 'rejected'
        ? { title: copy.notApprovedTitle, body: copy.notApprovedBody }
        : { title: copy.unreviewedTitle, body: copy.unreviewedBody }
  );
</script>

<div
  class="rounded-xl border border-dark-4 bg-dark-6 p-8 text-center"
  data-testid="review-status-panel"
>
  {#if kind === 'review'}
    <IconClockPause size={32} stroke={1.75} class="mx-auto text-buzz" />
  {:else}
    <IconInfoCircle size={32} stroke={1.75} class="mx-auto text-dark-2" />
  {/if}
  <h2 class="mt-3 text-base font-semibold text-white">{text.title}</h2>
  <p class="mx-auto mt-1 max-w-md text-sm text-dark-2">{text.body}</p>

  {#if canRaise}
    <p class="mx-auto mt-4 max-w-md text-sm text-dark-1">{copy.raiseBody}</p>
    <p class="mt-2 font-mono text-xs text-dark-0">
      Run ID: <span class="select-all">{workflowId}</span>
    </p>
    {#if supportUrl}
      <Button class="mt-4" variant="outline" href={supportUrl} target="_blank" rel="noreferrer">
        {copy.contactSupport}<IconExternalLink size={14} stroke={2} class="ml-1.5 inline" />
      </Button>
    {/if}
  {/if}

  {@render children?.()}
</div>
