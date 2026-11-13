<script lang="ts">
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { renderAnswer } from '$lib/assistant/answer';
  import { dateTime, num } from '$lib/format';
  import type { Turn } from '$lib/server/assistant/store';

  // One question and its answer. The answer is model output and may quote user-written text, so it is
  // rendered only through `renderAnswer`, which escapes everything before adding its few tags.
  // `sources`: every record any turn in this chat returned, which is what the server verified
  // citations against; an answer may cite a record an earlier turn looked up.
  let {
    turn,
    sources,
    onRefresh,
  }: { turn: Turn; sources: Turn['sources']; onRefresh: () => void } = $props();

  const html = $derived(turn.answer ? renderAnswer(turn.answer, sources) : '');
</script>

<article class="space-y-3">
  <div class="ml-auto max-w-[90%] rounded-lg bg-dark-5 px-3 py-2 text-sm break-words whitespace-pre-wrap text-dark-0 sm:max-w-[75%]">
    {#if turn.playbookSlug}
      <Badge variant="outline" class="mb-1">playbook: {turn.playbookSlug} v{turn.playbookVersion}</Badge>
    {/if}
    {turn.prompt}
  </div>

  <div class="rounded-lg border border-dark-4 bg-dark-6 px-4 py-3">
    {#if turn.status === 'done' && turn.answer}
      <!-- Escaped by `renderAnswer` before its own tags are added; see the comment above. -->
      <!-- eslint-disable-next-line svelte/no-at-html-tags -->
      <div class="answer text-sm text-dark-0">{@html html}</div>
      {#if turn.unverified.length}
        <p class="mt-2 text-xs text-amber-300">
          {turn.unverified.length === 1 ? 'One citation was' : `${turn.unverified.length} citations were`}
          not returned by any lookup in this chat ({turn.unverified.join(', ')}). Treat
          {turn.unverified.length === 1 ? 'it' : 'them'} as unverified.
        </p>
      {/if}
    {:else if turn.status === 'running'}
      <p class="flex items-center gap-2 text-sm text-dark-2">
        Still working on this one…
        <Button size="xs" variant="outline" onclick={onRefresh}>Refresh</Button>
      </p>
    {:else}
      <p class="text-sm text-red-300">{turn.error ?? 'No answer.'}</p>
    {/if}

    {#if turn.reasoning}
      <!-- Plain text, escaped by Svelte: model output never reaches {@html} here. -->
      <details class="mt-3 text-xs text-dark-2">
        <summary>Reasoning</summary>
        <p class="mt-2 mb-0 break-words whitespace-pre-wrap">{turn.reasoning}</p>
      </details>
    {/if}

    <details class="mt-3 text-xs text-dark-2">
      <summary>
        {turn.toolCalls.length ? `${turn.toolCalls.length} lookups` : 'No lookups'} ·
        {num(turn.totalTokens)} tokens · {dateTime(turn.createdAt)}
      </summary>
      {#if turn.toolCalls.length}
        <ol class="mt-2 space-y-1">
          {#each turn.toolCalls as call, i (i)}
            <li>
              <code class="text-dark-0">{call.name}</code>
              <code class="break-all">{JSON.stringify(call.args)}</code>
              → {call.error ? `error: ${call.error}` : `${num(call.rows)} rows${call.truncated ? ' (truncated)' : ''}`}
              · {num(call.ms)} ms
            </li>
          {/each}
        </ol>
      {/if}
    </details>
  </div>
</article>

<style>
  .answer :global(p) {
    margin: 0 0 0.5rem;
  }
  .answer :global(ul),
  .answer :global(ol) {
    margin: 0 0 0.5rem 1.25rem;
  }
  .answer :global(ul) {
    list-style: disc;
  }
  .answer :global(ol) {
    list-style: decimal;
  }
  .answer :global(h4) {
    margin: 0.75rem 0 0.25rem;
    font-weight: 600;
    color: white;
  }
  .answer :global(code) {
    font-size: 0.8em;
    overflow-wrap: anywhere;
  }
  /* A collected-ids block is one long line per id; it scrolls inside the card, not the page. */
  .answer :global(pre) {
    max-width: 100%;
    overflow-x: auto;
  }
  .answer :global(a.cite) {
    color: var(--color-blue-4);
    font-family: ui-monospace, monospace;
    font-size: 0.85em;
  }
  .answer :global(a.cite:hover) {
    text-decoration: underline;
  }
  .answer :global(.cite-unverified) {
    color: var(--color-amber-300);
    font-family: ui-monospace, monospace;
    font-size: 0.85em;
  }
</style>
