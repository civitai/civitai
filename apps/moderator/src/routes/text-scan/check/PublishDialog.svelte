<script lang="ts">
  import { enhance } from '$app/forms';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import * as Dialog from '@civitai/ui/components/ui/dialog/index.js';
  import { Label } from '@civitai/ui/components/ui/label/index.js';
  import { toast } from '@civitai/ui/components/ui/sonner/index.js';
  import { Textarea } from '@civitai/ui/components/ui/textarea/index.js';
  import { FormState } from '$lib/form-state.svelte';
  import { promptKeyName } from '$lib/text-scan-lab/labels';
  import type { PromptKey } from '$lib/text-scan-lab/types';
  import type { ChangesState } from './changes';

  let {
    changes,
    activeIds,
  }: {
    changes: ChangesState;
    activeIds: Partial<Record<PromptKey, number>>;
  } = $props();

  let open = $state(false);

  const names = (keys: readonly string[]) =>
    keys.map((k) => promptKeyName(k as PromptKey)).join(', ');

  // Sent with the changes, so the server can refuse when someone published since this page loaded.
  const loadedIds = $derived(
    JSON.stringify(Object.fromEntries(changes.keys.map((k) => [k, activeIds[k] ?? null])))
  );

  const publish = new FormState({
    reload: true,
    reset: false,
    onSuccess: (data) => {
      open = false;
      changes.discard();
      toast.success(`Published ${names((data?.published as string[] | undefined) ?? [])}`);
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
    <form method="POST" action="?/publish" use:enhance={publish.enhance} class="space-y-3">
      <input type="hidden" name="prompts" value={changes.json} />
      <input type="hidden" name="activeIds" value={loadedIds} />
      <div>
        <Label for="publish-note" class="text-xs text-dark-2">
          Publish note (recorded on each version)
        </Label>
        <Textarea id="publish-note" name="note" rows={3} maxlength={2000} required class="mt-1" />
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
