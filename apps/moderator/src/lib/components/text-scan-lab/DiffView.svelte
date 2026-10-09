<script lang="ts">
  import { diffLines } from '$lib/text-scan-lab/diff';

  let { before, after }: { before: string; after: string } = $props();

  const lines = $derived(diffLines(before, after));
  const changed = $derived(lines.some((l) => l.op !== 'same'));
</script>

{#if changed}
  <pre
    class="max-h-96 overflow-auto rounded-md border border-dark-4 bg-dark-7 p-2 text-xs leading-5 whitespace-pre-wrap">{#each lines as line, i (i)}<div
        class={line.op === 'add'
          ? 'bg-green-900/40 text-green-200'
          : line.op === 'del'
            ? 'bg-red-900/40 text-red-200'
            : 'text-dark-2'}>{line.op === 'add' ? '+ ' : line.op === 'del' ? '- ' : '  '}{line.text}</div>{/each}</pre>
{:else}
  <p class="text-xs text-dark-2">No changes.</p>
{/if}
