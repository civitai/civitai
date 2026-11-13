<script lang="ts">
  import { cn } from '@civitai/ui/utils.js';
  import { dateTime } from '$lib/format';
  import type { LabPromptLatest } from '$lib/server/text-scan-lab/harness-client';
  import type { ChangesState } from '$lib/text-scan-lab/changes';
  import { promptKeyName } from '$lib/text-scan-lab/labels';
  import { promptsHref } from '$lib/text-scan-lab/paths';
  import { PROMPT_KEYS, type PromptKey } from '$lib/text-scan-lab/types';

  let {
    active,
    changes,
    latest,
  }: {
    active: PromptKey;
    changes: ChangesState;
    latest: Partial<Record<string, LabPromptLatest>>;
  } = $props();
</script>

<nav
  aria-label="Prompts"
  class="flex flex-col gap-1 overflow-y-auto rounded-xl border border-dark-4 bg-dark-6 p-2"
>
  {#each PROMPT_KEYS as key (key)}
    {@const saved = latest[key]}
    <a
      href={promptsHref(key)}
      data-sveltekit-noscroll
      data-sveltekit-keepfocus
      aria-current={key === active ? 'page' : undefined}
      class={cn(
        'rounded-md px-3 py-2 text-sm',
        key === active ? 'bg-dark-5 text-white' : 'text-dark-0 hover:bg-dark-5/60'
      )}
    >
      <span class="flex items-center justify-between gap-2">
        {promptKeyName(key)}
        {#if changes.keys.includes(key)}
          <span class="size-2 rounded-full bg-amber-400" aria-hidden="true"></span>
          <span class="sr-only">unsaved draft</span>
        {/if}
      </span>
      <span class="block text-xs text-dark-2">
        {saved ? `Saved ${dateTime(saved.createdAt)}` : 'Never saved'}
      </span>
    </a>
  {/each}
</nav>
