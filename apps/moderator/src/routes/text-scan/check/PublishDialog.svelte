<script lang="ts">
  import { enhance } from '$app/forms';
  import { invalidateAll } from '$app/navigation';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import * as Dialog from '@civitai/ui/components/ui/dialog/index.js';
  import { Label } from '@civitai/ui/components/ui/label/index.js';
  import { toast } from '@civitai/ui/components/ui/sonner/index.js';
  import { Textarea } from '@civitai/ui/components/ui/textarea/index.js';
  import RunTotals from '$lib/components/text-scan-lab/RunTotals.svelte';
  import { FormState } from '$lib/form-state.svelte';
  import type { SetRunTotals } from '$lib/server/text-scan-lab/publish';
  import { promptKeyName } from '$lib/text-scan-lab/labels';
  import type { PromptKey } from '$lib/text-scan-lab/types';
  import { submitSaved, type ChangesState } from './changes';

  let {
    changes,
    runTotals,
    note,
    draftLabel,
  }: {
    changes: ChangesState;
    runTotals: SetRunTotals[];
    /** Prefills the publish note. */
    note: string;
    draftLabel: string;
  } = $props();

  let open = $state(false);

  const names = (keys: readonly string[]) => keys.map((k) => promptKeyName(k as PromptKey)).join(', ');

  const publish = new FormState({
    reload: true,
    reset: false,
    onSuccess: (data) => {
      open = false;
      const published = (data?.published as string[] | undefined) ?? [];
      toast.success(published.length ? `Published ${names(published)}` : 'Marked published');
    },
    // A partial publish changed the live prompts even though the action failed.
    onSettled: (result) => {
      if (result.type === 'failure' && (result.data?.published as string[] | undefined)?.length)
        void invalidateAll();
    },
  });
</script>

<Button size="sm" onclick={() => (open = true)}>Publish…</Button>

<Dialog.Root bind:open>
  <Dialog.Content class="sm:max-w-xl">
    <Dialog.Header>
      <Dialog.Title>Publish to production</Dialog.Title>
      <Dialog.Description>
        Every scan uses the new {changes.keys.length === 1 ? 'version' : 'versions'} of
        {names(changes.keys)} immediately.
      </Dialog.Description>
    </Dialog.Header>
    <RunTotals rows={runTotals} draftUpdatedAt={changes.token ? new Date(changes.token) : null} {draftLabel} />
    <form method="POST" action="?/publish" use:enhance={submitSaved(changes, publish)} class="space-y-3">
      <div>
        <Label for="publish-note" class="text-xs text-dark-2">
          Publish note (recorded on each version)
        </Label>
        <Textarea
          id="publish-note"
          name="note"
          rows={3}
          maxlength={2000}
          required
          class="mt-1"
          value={note}
        />
      </div>
      {#if publish.error}
        <p class="whitespace-pre-wrap text-sm text-red-300">{publish.error}</p>
      {/if}
      <Dialog.Footer>
        <Button type="button" variant="ghost" onclick={() => (open = false)}>Cancel</Button>
        <Button type="submit" variant="destructive" disabled={publish.submitting}>
          {publish.submitting ? 'Publishing…' : 'Publish'}
        </Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>
