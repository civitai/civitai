<script lang="ts">
  import { cn } from '@civitai/ui/utils.js';
  import { LINK_CLASS } from '$lib/format';
  import type { PromptDraft } from '$lib/server/text-scan-lab/drafts.service';
  import { promptKeyName } from '$lib/text-scan-lab/labels';
  import { PROMPT_KEYS, type PromptKey } from '$lib/text-scan-lab/types';

  let {
    drafts,
    selectedId,
    promptKey,
  }: { drafts: PromptDraft[]; selectedId: number | null; promptKey: PromptKey } = $props();

  const changed = (draft: PromptDraft) =>
    PROMPT_KEYS.filter((k) => k in draft.prompts)
      .map(promptKeyName)
      .join(', ') || 'no changes';
</script>

<section class="rounded-xl border border-dark-4 bg-dark-6 p-5">
  <h2 class="text-sm font-semibold text-white">Proposed drafts</h2>

  <p class="mt-1 text-xs text-dark-2">
    Drafts are proposed from Check. Open one there to test it, or here to review and publish it.
  </p>

  {#if drafts.length}
    <ul class="mt-3 space-y-1">
      {#each drafts as draft (draft.id)}
        <li
          class={cn(
            'flex items-baseline justify-between gap-2 rounded-md px-2 py-1 text-sm hover:bg-dark-5',
            draft.id === selectedId && 'bg-dark-5'
          )}
        >
          <a href="?draft={draft.id}&key={promptKey}" class="min-w-0 text-dark-0">
            {draft.name}
            <span class="text-xs text-dark-2">· {changed(draft)}</span>
          </a>
          <span class="flex shrink-0 items-baseline gap-2 text-xs text-dark-2">
            {draft.publishedAt
              ? `published ${draft.publishedAt.toLocaleDateString()}`
              : `edited ${draft.updatedAt.toLocaleString()}`}
            <a href="/text-scan/check?draft={draft.id}" class={LINK_CLASS}>Open in Check</a>
          </span>
        </li>
      {/each}
    </ul>
  {:else}
    <p class="mt-3 text-sm text-dark-2">No proposed drafts yet.</p>
  {/if}
</section>
