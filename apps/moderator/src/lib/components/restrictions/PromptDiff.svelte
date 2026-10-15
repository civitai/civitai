<script lang="ts">
  import { promptDiff } from '$lib/restrictions/prompt-diff';

  let { source, submitted }: { source: string; submitted: string } = $props();

  const parts = $derived(promptDiff(source, submitted));
</script>

<p class="m-0 text-sm leading-relaxed break-words whitespace-pre-wrap text-dark-0">{#each parts as part, i (i)}{#if part.kind === 'added'}<ins
        class="rounded-sm bg-emerald-500/20 text-emerald-200 no-underline">{part.text}</ins
      >{:else if part.kind === 'removed'}<del class="rounded-sm bg-red-500/20 text-red-200"
        >{part.text}</del
      >{:else}{part.text}{/if}{/each}</p>
