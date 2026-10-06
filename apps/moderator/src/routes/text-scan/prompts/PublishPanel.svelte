<script lang="ts">
  import type { Snippet } from 'svelte';
  import { enhance } from '$app/forms';
  import { invalidateAll } from '$app/navigation';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Label } from '@civitai/ui/components/ui/label/index.js';
  import { Textarea } from '@civitai/ui/components/ui/textarea/index.js';
  import { toast } from '@civitai/ui/components/ui/sonner/index.js';
  import { FormState } from '$lib/form-state.svelte';
  import type { PromptDraft } from '$lib/server/text-scan-lab/drafts.service';
  import { promptKeyName } from '$lib/text-scan-lab/labels';
  import { PROMPT_KEYS } from '$lib/text-scan-lab/types';

  let {
    draft,
    dirty,
    children,
  }: {
    draft: PromptDraft;
    dirty: boolean;
    children: Snippet;
  } = $props();

  const keys = $derived(PROMPT_KEYS.filter((k) => k in draft.prompts));
  // Bound to the saved version, so an edit after "Publish…" must be saved and confirmed afresh.
  let confirmedAt = $state<string | null>(null);
  const savedAt = $derived(draft.updatedAt.toISOString());
  const confirming = $derived(!dirty && confirmedAt === savedAt);

  const publish = new FormState({
    reload: true,
    onSuccess: (data) => {
      confirmedAt = null;
      const published = (data?.published as string[] | undefined) ?? [];
      toast.success(
        published.length ? `Published ${published.join(', ')}` : 'Draft marked published'
      );
    },
    // A partial publish changed the live prompts even though the action failed.
    onSettled: (result) => {
      if (result.type === 'failure' && (result.data?.published as string[] | undefined)?.length)
        void invalidateAll();
    },
  });
</script>

<div class="mt-5 border-t border-dark-4 pt-4">
  <h3 class="text-sm font-semibold text-white">Publish to production</h3>

  <div class="mt-2">{@render children()}</div>

  <form method="POST" action="?/publish" use:enhance={publish.enhance} class="mt-3">
    <input type="hidden" name="draftId" value={draft.id} />
    <input type="hidden" name="expectedUpdatedAt" value={savedAt} />
    <Label for="publish-note" class="text-xs text-dark-2">Publish note (recorded on each version)</Label>
    <Textarea
      id="publish-note"
      name="note"
      rows={2}
      maxlength={2000}
      required
      class="mt-1"
      value={draft.note ?? ''}
    />
    {#if dirty}
      <p class="mt-2 text-xs text-amber-300">Save your changes before publishing.</p>
    {:else if !keys.length}
      <p class="mt-2 text-xs text-dark-2">This draft changes nothing.</p>
    {:else if confirming}
      <p class="mt-2 text-sm text-dark-0">
        Publish {keys.map(promptKeyName).join(', ')} as the current versions? Every scan uses them immediately.
      </p>
      <div class="mt-2 flex gap-2">
        <Button type="submit" size="sm" variant="destructive" disabled={publish.submitting}>
          {publish.submitting ? 'Publishing…' : 'Confirm publish'}
        </Button>
        <Button size="sm" variant="ghost" onclick={() => (confirmedAt = null)}>Cancel</Button>
      </div>
    {:else}
      <Button class="mt-2" size="sm" onclick={() => (confirmedAt = savedAt)}>Publish…</Button>
    {/if}
    {#if publish.error}
      <p class="mt-2 text-sm text-red-300">{publish.error}</p>
    {/if}
  </form>
</div>
