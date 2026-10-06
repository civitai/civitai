<script lang="ts">
  import { enhance } from '$app/forms';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import * as Dialog from '@civitai/ui/components/ui/dialog/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import { Label } from '@civitai/ui/components/ui/label/index.js';
  import { toast } from '@civitai/ui/components/ui/sonner/index.js';
  import { Textarea } from '@civitai/ui/components/ui/textarea/index.js';
  import { FormState } from '$lib/form-state.svelte';
  import { submitSaved, type ChangesState } from './changes.svelte';

  let { changes }: { changes: ChangesState } = $props();

  let open = $state(false);

  const propose = new FormState({
    reload: true,
    onSuccess: (data) => {
      open = false;
      toast.success(`Proposed “${String(data?.name ?? '')}” — it is listed under Versions.`);
    },
  });
</script>

<Button size="sm" variant="outline" onclick={() => (open = true)}>Propose…</Button>

<Dialog.Root bind:open>
  <Dialog.Content>
    <Dialog.Header>
      <Dialog.Title>Propose your changes</Dialog.Title>
      <Dialog.Description>
        They become a named draft that other moderators can open in Check and find under Versions.
        Your own changes start empty again.
      </Dialog.Description>
    </Dialog.Header>
    <form
      method="POST"
      action="?/proposeChanges"
      use:enhance={submitSaved(changes, propose)}
      class="space-y-3"
    >
      <div>
        <Label for="propose-name" class="text-xs text-dark-2">Name</Label>
        <Input id="propose-name" name="name" required maxlength={100} class="mt-1" />
      </div>
      <div>
        <Label for="propose-note" class="text-xs text-dark-2">Why (optional)</Label>
        <Textarea id="propose-note" name="note" rows={3} maxlength={2000} class="mt-1" />
      </div>
      {#if propose.error}
        <p class="text-sm text-red-300">{propose.error}</p>
      {/if}
      <Dialog.Footer>
        <Button type="button" variant="ghost" onclick={() => (open = false)}>Cancel</Button>
        <Button type="submit" disabled={propose.submitting}>
          {propose.submitting ? 'Proposing…' : 'Propose'}
        </Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>
