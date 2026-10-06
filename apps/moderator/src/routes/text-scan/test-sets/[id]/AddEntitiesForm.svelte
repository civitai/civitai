<script lang="ts">
  import { enhance } from '$app/forms';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Label } from '@civitai/ui/components/ui/label/index.js';
  import * as Select from '@civitai/ui/components/ui/select/index.js';
  import { Textarea } from '@civitai/ui/components/ui/textarea/index.js';
  import { FormState } from '$lib/form-state.svelte';
  import { LAB_ENTITY_TYPES, type LabEntityType } from '$lib/text-scan-lab/types';

  type Outcome = {
    added: number;
    updated: number;
    skipped: { entityId: number; error: string }[];
  };

  let { maxIds }: { maxIds: number } = $props();

  let entityType = $state<LabEntityType>('Model');
  let outcome = $state<Outcome | null>(null);

  const add = new FormState({
    reload: true,
    onSubmit: () => (outcome = null),
    onSuccess: (r) => (outcome = r as unknown as Outcome),
  });
</script>

<form
  method="POST"
  action="?/addEntities"
  use:enhance={add.enhance}
  class="mb-4 rounded-xl border border-dark-4 bg-dark-6 p-5"
>
  <h2 class="text-sm font-semibold text-white">Add entities</h2>
  <p class="mt-1 text-xs text-dark-2">
    Snapshots each entity's live text as the scan composes it. New cases start with nothing
    expected; an entity already in the set gets its text refreshed and keeps its expectation.
  </p>
  <input type="hidden" name="entityType" value={entityType} />
  <div class="mt-3 flex flex-wrap items-start gap-3">
    <div class="flex flex-col gap-1">
      <Label for="add-entity-type" class="text-xs text-dark-2">Entity type</Label>
      <Select.Root
        type="single"
        bind:value={() => entityType, (v) => (entityType = v as LabEntityType)}
      >
        <Select.Trigger id="add-entity-type" class="w-48">{entityType}</Select.Trigger>
        <Select.Content>
          {#each LAB_ENTITY_TYPES as type (type)}
            <Select.Item value={type}>{type}</Select.Item>
          {/each}
        </Select.Content>
      </Select.Root>
    </div>
    <div class="flex min-w-64 flex-1 flex-col gap-1">
      <Label for="add-entity-ids" class="text-xs text-dark-2">
        Ids — comma or newline separated, up to {maxIds}
      </Label>
      <Textarea id="add-entity-ids" name="ids" required class="min-h-20 font-mono" />
    </div>
  </div>
  <div class="mt-3 flex flex-wrap items-center gap-3">
    <Button type="submit" size="sm" disabled={add.submitting}>
      {add.submitting ? 'Adding…' : 'Add'}
    </Button>
    {#if outcome}
      <p class="text-sm text-dark-0">
        Added {outcome.added}, refreshed {outcome.updated}.
      </p>
    {/if}
  </div>
  {#if outcome?.skipped.length}
    <p class="mt-2 text-sm text-amber-300">
      Not added: {outcome.skipped.map((s) => `${s.entityId} (${s.error})`).join(', ')}
    </p>
  {/if}
  {#if add.error}
    <p class="mt-2 whitespace-pre-wrap text-sm text-red-300">{add.error}</p>
  {/if}
</form>
