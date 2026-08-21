<script lang="ts">
  import type { PromptSegment } from '@civitai/mod-utils/prompt-audit';
  import { HIGHLIGHT_MARK } from '$lib/prompt-highlight';

  let { segments }: { segments: PromptSegment[] } = $props();
</script>

<p class="whitespace-pre-wrap break-words text-sm leading-relaxed">
  {#each segments as s, i (i)}
    {#if s.category}<mark class="rounded-sm px-0.5 {HIGHLIGHT_MARK[s.category]}">{s.text}</mark
      >{:else}{s.text}{/if}
  {/each}
</p>
