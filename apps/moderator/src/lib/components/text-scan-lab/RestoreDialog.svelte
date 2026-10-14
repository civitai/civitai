<script lang="ts">
  import { enhance } from '$app/forms';
  import { invalidateAll } from '$app/navigation';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import * as Dialog from '@civitai/ui/components/ui/dialog/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import { Label } from '@civitai/ui/components/ui/label/index.js';
  import { toast } from '@civitai/ui/components/ui/sonner/index.js';
  import { FormState } from '$lib/form-state.svelte';

  let {
    action,
    title,
    description,
    fields,
    withNote = true,
    onrestored = () => {},
  }: {
    action: string;
    title: string;
    description: string;
    fields: Record<string, string | number>;
    withNote?: boolean;
    onrestored?: () => void;
  } = $props();

  let open = $state(false);

  const restore = new FormState({
    reload: true,
    reset: false,
    onSuccess: (data) => {
      open = false;
      toast.success(String(data?.message ?? 'Restored as a new version'));
      onrestored();
    },
    onSettled: (result) => {
      if (result.type === 'failure') void invalidateAll();
    },
  });
</script>

<Button size="xs" variant="ghost" onclick={() => (open = true)}>Restore…</Button>

<Dialog.Root bind:open>
  <Dialog.Content class="sm:max-w-xl">
    <Dialog.Header>
      <Dialog.Title>{title}</Dialog.Title>
      <Dialog.Description>{description}</Dialog.Description>
    </Dialog.Header>
    <form method="POST" {action} use:enhance={restore.enhance} class="space-y-3">
      {#each Object.entries(fields) as [name, value] (name)}
        <input type="hidden" {name} {value} />
      {/each}
      {#if withNote}
        <div>
          <Label for="restore-note" class="text-xs text-dark-2">Note (optional)</Label>
          <Input id="restore-note" name="note" maxlength={2000} class="mt-1" />
        </div>
      {/if}
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
