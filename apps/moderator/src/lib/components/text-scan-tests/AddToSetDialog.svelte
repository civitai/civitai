<script lang="ts">
  import { plural } from '$lib/format';
  import { browser } from '$app/environment';
  import { enhance } from '$app/forms';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import * as Dialog from '@civitai/ui/components/ui/dialog/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import { Label } from '@civitai/ui/components/ui/label/index.js';
  import * as Select from '@civitai/ui/components/ui/select/index.js';
  import { toast } from '@civitai/ui/components/ui/sonner/index.js';
  import { fetchJson } from '$lib/fetch-json';
  import { FormState } from '$lib/form-state.svelte';
  import type { LabEntityType, LabField, LabLabel } from '$lib/text-scan-lab/types';
  import type { Expected } from '$lib/text-scan-tests/expected';
  import type { SetOption, Workspace } from '$lib/text-scan-tests/types';
  import ExpectedEditor from './ExpectedEditor.svelte';

  let {
    workspace,
    entityType,
    labels,
    entityId,
    fields,
    origin,
    prefill,
  }: {
    workspace: Workspace;
    entityType: LabEntityType;
    labels: readonly LabLabel[];
    entityId: number | null;
    fields: LabField[] | null;
    origin: 'try' | 'matches';
    prefill: Expected;
  } = $props();

  const NEW = 'new';

  let open = $state(false);
  let setChoice = $state('');
  let newSetName = $state('');
  let note = $state('');
  let expected = $state<Expected>({});

  const sets = $derived(
    browser && open
      ? fetchJson<{ sets: SetOption[] }>(`/text-scan/test-sets/sets?workspace=${workspace}`)
      : null
  );
  const idPrefix = $derived(`add-${entityType}-${entityId ?? 'text'}`);
  const ready = $derived(setChoice !== '' && (setChoice !== NEW || newSetName.trim() !== ''));

  function start() {
    expected = $state.snapshot(prefill) as Expected;
    note = '';
    newSetName = '';
    setChoice = '';
    save.error = null;
    open = true;
  }

  const save = new FormState({
    reset: false,
    onSuccess: (data) => {
      open = false;
      toast.success(data?.created ? 'Added to the test set' : 'Updated that case in the test set');
    },
  });
</script>

<Button size="xs" variant="ghost" onclick={start}>Add to test set</Button>

<Dialog.Root bind:open>
  <Dialog.Content class="sm:max-w-xl">
    <Dialog.Header>
      <Dialog.Title>Add to a test set</Dialog.Title>
      <Dialog.Description>
        Saves this text and the verdict you expect. It starts from the current verdict.
      </Dialog.Description>
    </Dialog.Header>
    <form method="POST" action="/text-scan/test-sets?/addCase" use:enhance={save.enhance} class="space-y-4">
      <input type="hidden" name="workspace" value={workspace} />
      <input type="hidden" name="entityType" value={entityType} />
      <input type="hidden" name="origin" value={origin} />
      {#if entityId !== null}
        <input type="hidden" name="entityId" value={entityId} />
      {:else if fields}
        <input type="hidden" name="fields" value={JSON.stringify(fields)} />
      {/if}
      {#if setChoice !== '' && setChoice !== NEW}
        <input type="hidden" name="setId" value={setChoice} />
      {/if}

      <div>
        <span class="text-xs text-dark-2" id="{idPrefix}-set">Test set</span>
        {#snippet picker(options: SetOption[])}
          <Select.Root type="single" bind:value={setChoice}>
            <Select.Trigger class="mt-1 w-full" aria-labelledby="{idPrefix}-set">
              {setChoice === NEW
                ? 'New set…'
                : options.find((s) => String(s.id) === setChoice)?.name ?? 'Pick a test set'}
            </Select.Trigger>
            <Select.Content>
              {#each options as set (set.id)}
                <Select.Item value={String(set.id)}>{set.name} · {plural(set.caseCount, 'case')}</Select.Item>
              {/each}
              <Select.Item value={NEW}>New set…</Select.Item>
            </Select.Content>
          </Select.Root>
        {/snippet}
        {#await sets}
          <p class="mt-1 text-sm text-dark-2">Loading test sets…</p>
        {:then loaded}
          {@render picker(loaded?.sets ?? [])}
        {:catch}
          <p class="mt-1 text-sm text-red-300">
            Could not load the test sets. You can still save to a new one.
          </p>
          {@render picker([])}
        {/await}
        {#if setChoice === NEW}
          <Input
            name="newSetName"
            bind:value={newSetName}
            maxlength={100}
            placeholder="New set name"
            aria-label="New set name"
            class="mt-2"
          />
        {/if}
      </div>

      <ExpectedEditor {labels} bind:expected {idPrefix} />

      <div>
        <Label for="{idPrefix}-note" class="text-xs text-dark-2">Note (optional)</Label>
        <Input id="{idPrefix}-note" name="note" maxlength={1000} bind:value={note} class="mt-1" />
      </div>

      {#if save.error}
        <p class="whitespace-pre-wrap text-sm text-red-300">{save.error}</p>
      {/if}
      <Dialog.Footer>
        <Button type="button" variant="ghost" onclick={() => (open = false)}>Cancel</Button>
        <Button type="submit" disabled={!ready || save.submitting}>
          {save.submitting ? 'Saving…' : 'Save case'}
        </Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>
