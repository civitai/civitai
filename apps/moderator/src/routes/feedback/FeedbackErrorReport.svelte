<script lang="ts">
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { clipboardFeedback } from '$lib/clipboard.svelte';
  import type { FeedbackContext } from '$lib/feedback';

  let { context }: { context: FeedbackContext } = $props();

  const ids = $derived(
    (
      [
        ['Error ref', context.errorRef],
        ['Workflow', context.workflowId],
        ['Job', context.jobId],
      ] satisfies [string, string | null][]
    ).filter((entry): entry is [string, string] => entry[1] !== null)
  );

  const clipboard = clipboardFeedback();
</script>

<!-- 🔴 TEXT ONLY: no href, no src, no {@html}. Every value here is the reporter's claim, and the ids
     are copied into the orchestrator's own tooling, never followed from this page. Pinned in
     `feedback-panel-tripwires.test.ts` (REQUEST_FREE_FILES). -->
{#if context.toast || ids.length}
  <div class="flex min-w-0 flex-col gap-2 rounded-lg border border-dark-4 bg-dark-7 p-3 text-sm">
    {#if context.toast}
      <div class="flex min-w-0 flex-col gap-0.5">
        <span class="text-xs text-dark-2">The error they were shown</span>
        {#if context.toast.title}
          <span class="font-semibold wrap-break-word">{context.toast.title}</span>
        {/if}
        <span class="wrap-break-word whitespace-pre-wrap">{context.toast.message}</span>
      </div>
    {/if}
    {#if ids.length}
      <dl class="grid grid-cols-[auto_1fr_auto] items-center gap-x-3 gap-y-0.5">
        {#each ids as [label, value] (label)}
          <dt class="text-dark-2">{label}</dt>
          <dd><code class="font-mono wrap-anywhere">{value}</code></dd>
          <dd>
            <Button size="sm" variant="ghost" onclick={() => clipboard.copy(value, label)}>
              {clipboard.copied(label) ? 'Copied' : clipboard.failed(label) ? 'Copy failed' : 'Copy'}
            </Button>
          </dd>
        {/each}
      </dl>
    {/if}
  </div>
{/if}
