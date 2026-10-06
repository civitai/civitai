<script lang="ts">
  import { num } from '$lib/format';
  import type { LabLabel, LabScanResult } from '$lib/text-scan-lab/types';

  let {
    title,
    result,
    labels,
  }: { title: string; result: LabScanResult; labels: readonly LabLabel[] } = $props();

  const reasonOf = (label: LabLabel) => {
    if (!result.ok || !result.output) return null;
    const v = result.output[label] as { reason?: unknown } | undefined;
    return typeof v?.reason === 'string' ? v.reason : null;
  };
</script>

<div class="min-w-0 rounded-lg border border-dark-4 bg-dark-7 p-4">
  <h4 class="text-xs font-semibold uppercase tracking-wide text-dark-2">{title}</h4>

  {#if !result.ok}
    <p class="mt-2 whitespace-pre-wrap break-words text-sm text-red-300">{result.error}</p>
  {:else}
    <p class="mt-1 break-all text-xs text-dark-2">
      Workflow <span class="font-mono text-dark-0">{result.workflowId}</span> · {num(
        result.elapsedMs
      )} ms
    </p>
    <p class="mt-1 text-xs text-dark-2">
      Prompts:
      {#each Object.entries(result.promptIds) as [key, id] (key)}
        <span class="ml-1 font-mono text-dark-0">{key}#{id}</span>
      {/each}
    </p>

    {#if result.output}
      <dl class="mt-3 space-y-2">
        {#each labels as label (label)}
          <div>
            <dt class="text-xs font-semibold text-white">{label}</dt>
            <dd class="whitespace-pre-wrap text-sm text-dark-0">{reasonOf(label) ?? '—'}</dd>
          </div>
        {/each}
      </dl>
      <details class="mt-3">
        <summary class="text-xs text-dark-2">Output JSON</summary>
        <pre class="mt-1 overflow-x-auto text-xs text-dark-0">{JSON.stringify(
            result.output,
            null,
            2
          )}</pre>
      </details>
    {:else}
      <p class="mt-2 text-sm text-red-300">Could not parse the reply: {result.parseError}</p>
      {#if result.rawContent !== undefined}
        <pre class="mt-2 overflow-x-auto whitespace-pre-wrap text-xs text-dark-0">{result.rawContent}</pre>
      {/if}
    {/if}
  {/if}
</div>
