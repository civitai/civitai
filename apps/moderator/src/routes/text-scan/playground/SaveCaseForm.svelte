<script lang="ts">
  import type { SubmitFunction } from '@sveltejs/kit';
  import { untrack } from 'svelte';
  import { enhance } from '$app/forms';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import * as Select from '@civitai/ui/components/ui/select/index.js';
  import ExpectedEditor from '$lib/components/text-scan-lab/ExpectedEditor.svelte';
  import { FormState } from '$lib/form-state.svelte';
  import { LINK_CLASS } from '$lib/format';
  import { expectedFromOutput } from '$lib/text-scan-lab/expected';
  import type { Expected, LabEntityType, LabLabel } from '$lib/text-scan-lab/types';
  import type { RunItemResult } from './+page.server';

  let {
    item,
    entityType,
    labels,
    testSets,
  }: {
    item: RunItemResult;
    entityType: LabEntityType;
    labels: readonly LabLabel[];
    testSets: { id: number; name: string }[];
  } = $props();

  // Prefilled from what version A (active) said; the moderator corrects it before saving.
  let expected = $state<Expected>(
    untrack(() => expectedFromOutput(item.a.ok ? item.a.output : null, labels))
  );
  let setId = $state(untrack(() => String(testSets[0]?.id ?? '')));
  let open = $state(false);
  let saved = $state<{ setId: string; created: boolean } | null>(null);

  const setName = (id: string) => testSets.find((s) => String(s.id) === id)?.name ?? '';
  const save = new FormState({
    reset: false,
    onSuccess: (r) => {
      saved = { setId, created: r?.created === true };
      open = false;
    },
  });
  // The action lives on the test-set route: applying its unexpected error would render that route's
  // error page over the playground, so it is shown as this form's refusal instead.
  const enhanceSave: SubmitFunction = async (input) => {
    const settle = await save.enhance(input);
    if (!settle) return;
    return (opts) => {
      if (opts.result.type !== 'error') return settle(opts);
      const message = (opts.result.error as { message?: string } | undefined)?.message;
      return settle({
        ...opts,
        result: {
          type: 'failure',
          status: opts.result.status ?? 500,
          data: { error: message || 'Something went wrong.' },
        },
        update: async () => {},
      });
    };
  };
</script>

{#if !open}
  <div class="mt-3 flex flex-wrap items-center gap-3">
    <Button size="sm" variant="outline" onclick={() => (open = true)}>Save as test case</Button>
    {#if saved}
      <p class="text-xs text-dark-2">
        {saved.created ? 'Saved to' : 'Updated in'}
        <a href="/text-scan/test-sets/{saved.setId}" class={LINK_CLASS}>{setName(saved.setId)}</a>.
      </p>
    {/if}
  </div>
{:else}
  <form
    method="POST"
    action="/text-scan/test-sets/{setId}?/addCase"
    use:enhance={enhanceSave}
    class="mt-3 space-y-3 rounded-lg border border-dark-4 bg-dark-7 p-4"
  >
    <input type="hidden" name="entityType" value={entityType} />
    <input type="hidden" name="entityId" value={item.entityId ?? ''} />
    <input type="hidden" name="authorId" value={item.authorId ?? ''} />
    <input type="hidden" name="fields" value={JSON.stringify(item.fields)} />
    <div class="flex flex-wrap items-center gap-2">
      <span class="text-xs text-dark-2">Save to</span>
      <Select.Root type="single" bind:value={setId}>
        <Select.Trigger class="w-56" aria-label="Test set">{setName(setId)}</Select.Trigger>
        <Select.Content>
          {#each testSets as s (s.id)}
            <Select.Item value={String(s.id)}>{s.name}</Select.Item>
          {/each}
        </Select.Content>
      </Select.Root>
      {#if item.entityId !== null}
        <span class="text-xs text-dark-2">replaces this entity's case if the set has one</span>
      {/if}
    </div>
    <ExpectedEditor {labels} bind:expected idPrefix="save-{item.key}" />
    <div class="flex flex-wrap items-center gap-2">
      <Input name="note" placeholder="Note (optional)" maxlength={1000} class="min-w-64 flex-1" />
      <Button type="submit" size="sm" disabled={save.submitting || !setId}>Save</Button>
      <Button type="button" size="sm" variant="ghost" onclick={() => (open = false)}>Cancel</Button>
    </div>
    {#if save.error}<p class="text-sm text-red-300">{save.error}</p>{/if}
  </form>
{/if}
