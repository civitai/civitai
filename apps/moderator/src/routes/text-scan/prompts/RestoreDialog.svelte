<script lang="ts">
  import { enhance } from '$app/forms';
  import { invalidateAll } from '$app/navigation';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import * as Dialog from '@civitai/ui/components/ui/dialog/index.js';
  import { Label } from '@civitai/ui/components/ui/label/index.js';
  import { toast } from '@civitai/ui/components/ui/sonner/index.js';
  import { Textarea } from '@civitai/ui/components/ui/textarea/index.js';
  import { FormState } from '$lib/form-state.svelte';
  import { promptKeyName } from '$lib/text-scan-lab/labels';
  import type { PromptKey } from '$lib/text-scan-lab/types';

  let {
    promptKey,
    versionId,
    activeId,
  }: { promptKey: PromptKey; versionId: number; activeId: number } = $props();

  let open = $state(false);

  const restore = new FormState({
    reload: true,
    reset: false,
    onSuccess: () => {
      open = false;
      toast.success(`Restored ${promptKeyName(promptKey)} as a new version`);
    },
    // A refusal means the page is behind: reload so the next try carries the version now current.
    onSettled: (result) => {
      if (result.type === 'failure') void invalidateAll();
    },
  });
</script>

<Button size="sm" variant="ghost" onclick={() => (open = true)}>Restore…</Button>

<Dialog.Root bind:open>
  <Dialog.Content class="sm:max-w-xl">
    <Dialog.Header>
      <Dialog.Title>Restore version #{versionId}</Dialog.Title>
      <Dialog.Description>
        Publishes this text as a new version of {promptKeyName(promptKey)}. Every scan uses it
        immediately; the versions in between stay in the history.
      </Dialog.Description>
    </Dialog.Header>
    <form method="POST" action="?/restore" use:enhance={restore.enhance} class="space-y-3">
      <input type="hidden" name="key" value={promptKey} />
      <input type="hidden" name="id" value={versionId} />
      <input type="hidden" name="activeId" value={activeId} />
      <div>
        <Label for="restore-note-{versionId}" class="text-xs text-dark-2">
          Note (recorded on the new version)
        </Label>
        <Textarea
          id="restore-note-{versionId}"
          name="note"
          rows={3}
          maxlength={2000}
          required
          value="Restore #{versionId}"
          class="mt-1"
        />
      </div>
      {#if restore.error}
        <p class="whitespace-pre-wrap text-sm text-red-300">{restore.error}</p>
      {/if}
      <Dialog.Footer>
        <Button type="button" variant="ghost" onclick={() => (open = false)}>Cancel</Button>
        <Button type="submit" variant="destructive" disabled={restore.submitting}>
          {restore.submitting ? 'Restoring…' : 'Restore'}
        </Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>
