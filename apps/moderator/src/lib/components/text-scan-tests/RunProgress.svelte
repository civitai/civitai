<script lang="ts">
  import { enhance } from '$app/forms';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Progress } from '@civitai/ui/components/ui/progress/index.js';
  import { FormState } from '$lib/form-state.svelte';
  import type { Jsonified } from '$lib/format';
  import type { RunView } from '$lib/server/text-scan-tests/reports';
  import { RUN_KIND_NAMES, isCancellable } from '$lib/text-scan-tests/types';

  let {
    run,
    canCancel,
    action = '?/cancelRun',
    onchanged,
  }: {
    run: Jsonified<RunView>;
    canCancel: boolean;
    action?: string;
    onchanged: () => void;
  } = $props();

  const STATUS: Record<string, string> = {
    queued: 'Waiting to start',
    running: 'Scanning',
    cancelling: 'Stopping after this chunk',
  };

  const cancel = new FormState({ reset: false, onSuccess: () => onchanged() });
  const percent = $derived(run.caseTotal ? Math.round((run.caseDone / run.caseTotal) * 100) : 0);
</script>

<div class="rounded-lg border border-dark-4 bg-dark-7 p-3">
  <div class="flex items-center justify-between gap-2 text-xs text-dark-2">
    <span>
      #{run.id} {RUN_KIND_NAMES[run.kind]} · {STATUS[run.status] ?? run.status} ·
      {run.caseDone}/{run.caseTotal}{#if run.errorCount} · {run.errorCount} errors{/if}
    </span>
    {#if canCancel && isCancellable(run.status)}
      <form method="POST" {action} use:enhance={cancel.enhance}>
        <input type="hidden" name="setId" value={run.setId} />
        <input type="hidden" name="runId" value={run.id} />
        <Button type="submit" size="xs" variant="ghost" disabled={cancel.submitting}>Cancel</Button>
      </form>
    {/if}
  </div>
  <Progress value={percent} class="mt-2" aria-label="Run progress" />
  {#if run.interrupted}
    <p class="mt-1 text-xs text-amber-300">Interrupted. It resumes now that this page is open.</p>
  {/if}
  {#if cancel.error}
    <p class="mt-1 text-xs text-red-300">{cancel.error}</p>
  {/if}
</div>
