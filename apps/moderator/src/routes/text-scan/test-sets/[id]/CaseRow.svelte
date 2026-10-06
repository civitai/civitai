<script lang="ts">
  import { enhance } from '$app/forms';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import * as Table from '@civitai/ui/components/ui/table/index.js';
  import ConfirmSubmit from '$lib/components/ConfirmSubmit.svelte';
  import ExpectedEditor from '$lib/components/text-scan-lab/ExpectedEditor.svelte';
  import { FormState } from '$lib/form-state.svelte';
  import { LINK_CLASS, dateTime } from '$lib/format';
  import type { TestCase } from '$lib/server/text-scan-lab/test-sets.service';
  import { caseSourceHref } from '$lib/text-scan-lab/case-view';
  import { composeUserMessage } from '$lib/text-scan-lab/compose';
  import { ENTITY_TYPE_NAMES, NOTHING_SCORED, expectedChips } from '$lib/text-scan-lab/labels';
  import { LAB_LABELS, type Expected } from '$lib/text-scan-lab/types';

  let {
    testCase,
    civitaiUrl,
    canEdit,
  }: { testCase: TestCase; civitaiUrl: string; canEdit: boolean } = $props();

  const PREVIEW_CHARS = 200;
  const text = $derived(testCase.fields ? composeUserMessage(testCase.fields) : null);
  const href = $derived(caseSourceHref(civitaiUrl, testCase.entityType, testCase.entityId));
  const chips = $derived(expectedChips(testCase.expected));

  let editing = $state(false);
  let draft = $state<Expected>({});
  let note = $state('');
  function startEdit() {
    draft = $state.snapshot(testCase.expected);
    note = testCase.note ?? '';
    editing = true;
  }

  const save = new FormState({ reload: true, reset: false, onSuccess: () => (editing = false) });
  const remove = new FormState({ reload: true, onSuccess: null });
</script>

<Table.Row id="case-{testCase.id}" class="target:bg-dark-5">
  <Table.Cell class="align-top">
    <p class="text-xs text-dark-2">{ENTITY_TYPE_NAMES[testCase.entityType]}</p>
    {#if testCase.entityId === null}
      <p class="text-dark-0">Free text</p>
    {:else if href}
      <a {href} target="_blank" rel="noopener" class={LINK_CLASS}>#{testCase.entityId}</a>
    {:else}
      <p class="text-dark-0">#{testCase.entityId}</p>
    {/if}
    {#if testCase.synthetic}<Badge variant="outline" class="mt-1">synthetic</Badge>{/if}
    {#if testCase.sourceDeletedAt}
      <Badge variant="destructive" class="mt-1" title={dateTime(testCase.sourceDeletedAt)}>
        source deleted
      </Badge>
    {/if}
  </Table.Cell>
  <Table.Cell class="max-w-xl whitespace-normal align-top">
    {#if text === null}
      <p class="text-sm text-dark-2">Text removed with its source.</p>
    {:else if text.length <= PREVIEW_CHARS}
      <p class="whitespace-pre-wrap break-words text-sm text-dark-0">{text}</p>
    {:else}
      <details>
        <summary class="whitespace-pre-wrap break-words text-sm text-dark-0">
          {text.slice(0, PREVIEW_CHARS)}…
        </summary>
        <p class="mt-1 whitespace-pre-wrap break-words text-sm text-dark-0">{text}</p>
      </details>
    {/if}
    {#if testCase.note}<p class="mt-1 text-xs text-dark-2">Note: {testCase.note}</p>{/if}
    {#if text !== null}
      <a
        href="/text-scan/check?set={testCase.setId}&case={testCase.id}"
        class="mt-1 inline-block text-xs {LINK_CLASS}">Open in Check</a
      >
    {/if}
  </Table.Cell>
  <Table.Cell class="align-top">
    <div class="flex flex-wrap gap-1">
      {#each chips as chip (chip)}
        <Badge variant="secondary">{chip}</Badge>
      {:else}
        <span class="text-xs text-dark-2">{NOTHING_SCORED}</span>
      {/each}
    </div>
  </Table.Cell>
  {#if canEdit}
    <Table.Cell class="text-right align-top">
      <form
        method="POST"
        action="?/removeCase"
        use:enhance={remove.enhance}
        class="flex flex-wrap justify-end gap-2"
      >
        {#if !editing}
          <Button type="button" size="sm" variant="outline" onclick={startEdit}>Edit</Button>
        {/if}
        <ConfirmSubmit
          label="Remove"
          name="caseId"
          value={String(testCase.id)}
          count={1}
          noun="case"
          submitting={remove.submitting}
        />
      </form>
      {#if remove.error}<p class="mt-1 text-sm text-red-300">{remove.error}</p>{/if}
    </Table.Cell>
  {/if}
</Table.Row>
{#if editing}
  <Table.Row>
    <Table.Cell colspan={4} class="bg-dark-7">
      <form method="POST" action="?/updateExpected" use:enhance={save.enhance} class="space-y-3">
        <input type="hidden" name="caseId" value={testCase.id} />
        <ExpectedEditor
          labels={LAB_LABELS[testCase.entityType]}
          bind:expected={draft}
          idPrefix="case-{testCase.id}"
        />
        <div class="flex flex-wrap items-center gap-2">
          <Input
            name="note"
            placeholder="Note (optional)"
            maxlength={1000}
            bind:value={note}
            class="min-w-64 flex-1"
          />
          <Button type="submit" size="sm" disabled={save.submitting}>Save</Button>
          <Button type="button" size="sm" variant="ghost" onclick={() => (editing = false)}>
            Cancel
          </Button>
        </div>
        {#if save.error}<p class="text-sm text-red-300">{save.error}</p>{/if}
      </form>
    </Table.Cell>
  </Table.Row>
{/if}
