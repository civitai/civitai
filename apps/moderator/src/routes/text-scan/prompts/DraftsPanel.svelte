<script lang="ts">
  import { enhance } from '$app/forms';
  import { goto } from '$app/navigation';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import { cn } from '@civitai/ui/utils.js';
  import { FormState } from '$lib/form-state.svelte';
  import type { PromptDraft } from '$lib/server/text-scan-lab/drafts.service';
  import type { PromptKey } from '$lib/text-scan-lab/types';

  let {
    drafts,
    selectedId,
    promptKey,
  }: { drafts: PromptDraft[]; selectedId: number | null; promptKey: PromptKey } = $props();

  const create = new FormState({
    reload: true,
    onSuccess: (data) => {
      if (typeof data?.draftId === 'number') goto(`?draft=${data.draftId}&key=${promptKey}`);
    },
  });
</script>

<section class="rounded-xl border border-dark-4 bg-dark-6 p-5">
  <h2 class="text-sm font-semibold text-white">Drafts</h2>

  <form
    method="POST"
    action="?/createDraft"
    use:enhance={create.enhance}
    class="mt-3 flex flex-wrap items-center gap-2"
  >
    <Input name="name" placeholder="New draft name" maxlength={100} required class="w-56" />
    <Input name="note" placeholder="Note (optional)" maxlength={2000} class="min-w-40 flex-1" />
    <Button type="submit" size="sm" disabled={create.submitting}>Create</Button>
  </form>
  {#if create.error}
    <p class="mt-2 text-sm text-red-300">{create.error}</p>
  {/if}

  {#if drafts.length}
    <ul class="mt-3 space-y-1">
      {#each drafts as draft (draft.id)}
        <li>
          <a
            href="?draft={draft.id}&key={promptKey}"
            class={cn(
              'flex items-baseline justify-between gap-2 rounded-md px-2 py-1 text-sm hover:bg-dark-5',
              draft.id === selectedId && 'bg-dark-5'
            )}
          >
            <span class="text-dark-0">
              {draft.name}
              <span class="text-xs text-dark-2">
                · {Object.keys(draft.prompts).join(', ') || 'no overrides'}
              </span>
            </span>
            <span class="shrink-0 text-xs text-dark-2">
              {draft.publishedAt
                ? `published ${draft.publishedAt.toLocaleDateString()}`
                : `edited ${draft.updatedAt.toLocaleString()}`}
            </span>
          </a>
        </li>
      {/each}
    </ul>
  {:else}
    <p class="mt-3 text-sm text-dark-2">No drafts yet.</p>
  {/if}
</section>
