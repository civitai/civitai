<script lang="ts">
  import { dateTime } from '$lib/format';
  import { ago } from '$lib/minor-flags/appeal-row';
  import type { ModelFlagDetail } from '$lib/minor-flags/model-detail';

  /** "text scan with web search, prompt v14, 2d ago": where a text-scan verdict came from. */
  let {
    at,
    source,
    promptId,
    detail,
  }: {
    at: Date | string | null | undefined;
    /** Which pass raised it, while its scan row still says; null leaves the pass unnamed. */
    source: 'main' | 'web search' | null;
    promptId: number | null;
    detail: Promise<ModelFlagDetail>;
  } = $props();
</script>

text scan{source === 'web search' ? ' with web search' : ''}{#if promptId}{#await detail}{:then d}{#if d.promptVersions[promptId]},
      prompt v{d.promptVersions[promptId]}{/if}{:catch}, prompt version unavailable{/await}{/if}{#if at},
  <span title={dateTime(at)}>{ago(at)}</span>{/if}
