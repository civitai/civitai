<script lang="ts">
  import { num } from '$lib/format';
  import type { LabScanResult } from '$lib/text-scan-lab/types';

  let { title, result }: { title: string; result: LabScanResult } = $props();
</script>

<div class="min-w-0 rounded-lg border border-dark-4 bg-dark-7 p-4">
  <h4 class="text-xs font-semibold uppercase tracking-wide text-dark-2">{title}</h4>
  {#if result.workflowId}
    <p class="mt-1 break-all text-xs text-dark-2">
      Workflow <span class="font-mono text-dark-0">{result.workflowId}</span>{result.ok
        ? ` · ${num(result.elapsedMs)} ms`
        : ''}
    </p>
  {/if}
  {#if !result.ok}
    <p class="mt-2 whitespace-pre-wrap break-words text-sm text-red-300">{result.error}</p>
  {:else}
    <p class="mt-1 text-xs text-dark-2">
      Prompt versions:
      {#each Object.entries(result.promptIds) as [key, id] (key)}
        <span class="ml-1 font-mono text-dark-0">{key}#{id}</span>
      {/each}
    </p>
    {#if result.output}
      <pre class="mt-2 overflow-x-auto text-xs text-dark-0">{JSON.stringify(
          result.output,
          null,
          2
        )}</pre>
    {:else}
      <p class="mt-2 text-sm text-red-300">Could not read the reply: {result.parseError}</p>
      {#if result.rawContent !== undefined}
        <pre class="mt-2 overflow-x-auto whitespace-pre-wrap text-xs text-dark-0">{result.rawContent}</pre>
      {/if}
    {/if}
  {/if}
</div>
