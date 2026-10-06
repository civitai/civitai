<script lang="ts">
  import { untrack } from 'svelte';
  import { beforeNavigate, goto } from '$app/navigation';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import type { PromptKey } from '$lib/text-scan-lab/types';
  import type { ActionData } from './$types';
  import type { ChangesSource } from './+page.server';
  import type { ChangesInit } from './changes';
  import { createChanges } from './changes.svelte';
  import ChangesBar from './ChangesBar.svelte';
  import CheckForm from './CheckForm.svelte';
  import CheckItem from './CheckItem.svelte';
  import PromptEditor from './PromptEditor.svelte';

  let { data } = $props();

  type CheckData = Extract<NonNullable<ActionData>, { checked: true }>;

  const changesInit = (source: ChangesSource): ChangesInit => ({
    prompts: source.draft?.prompts ?? {},
    draftId: source.draft?.id ?? null,
    token: source.draft?.updatedAt.toISOString() ?? null,
    target: source.kind === 'draft' ? source.draft.id : null,
    editable: source.kind === 'mine' || source.editable,
  });

  const changes = createChanges(untrack(() => changesInit(data.changes)));
  // A reload (after propose, publish, discard, or a conflict) or another ?draft= replaces what is tested.
  $effect(() => {
    const next = changesInit(data.changes);
    untrack(() => changes.reset(next));
  });

  // Set while this page itself re-issues a navigation it held back to save first.
  let resuming = false;
  beforeNavigate((nav) => {
    if (resuming || !changes.dirty) return;
    if (nav.type === 'leave') {
      // Unsaveable as they stand: let the browser ask. Otherwise the save outlives the page.
      if (changes.blankError || changes.conflict) nav.cancel();
      else void changes.flush({ keepalive: true });
      return;
    }
    const to = nav.to?.url;
    if (nav.type !== 'link' || !to) {
      void changes.flush();
      return;
    }
    nav.cancel();
    void changes.flush().then(async (saved) => {
      if (!saved && !confirm('Your changes are not saved. Leave anyway?')) return;
      resuming = true;
      try {
        await goto(to);
      } finally {
        resuming = false;
      }
    });
  });

  // Outlives the bar, which a discard removes along with the changes it reports on.
  let barError = $state<string | null>(null);

  let result = $state<CheckData | null>(null);
  // What was tested in the shown result, to say when the changes moved on since.
  let checkedWith = $state<string | null>(null);
  let editing = $state<PromptKey | null>(null);

  const current = $derived(data.active.ok ? data.active.content : {});
  const viewing = $derived(data.changes.kind === 'draft');
  const showBar = $derived(viewing || changes.keys.length > 0 || changes.dirty);
  const changedTitle = $derived(viewing ? 'With this draft' : 'With my changes');
</script>

<svelte:head><title>Check · Text scan</title></svelte:head>

<div class="mb-4 flex flex-wrap items-baseline justify-between gap-2">
  <h1 class="text-xl font-semibold text-white">Check</h1>
  <Button size="sm" variant="ghost" onclick={() => (editing = 'base')}>
    Edit general instructions
  </Button>
</div>

{#if data.draftNotice}
  <p class="mb-4 text-sm text-amber-300">{data.draftNotice}</p>
{/if}

{#if showBar}
  <ChangesBar
    {changes}
    source={data.changes}
    workingCopy={data.workingCopy}
    canPublish={!!data.grants['textScan.prompt.publish']}
    runTotals={data.runTotals}
    onedit={(key) => (editing = key)}
    onerror={(error) => (barError = error)}
  />
{/if}
{#if barError}
  <p class="mb-4 text-sm text-red-300">{barError}</p>
{/if}

<CheckForm
  overrides={changes.json}
  overridesError={changes.blankError}
  onstart={() => {
    result = null;
    checkedWith = changes.json;
  }}
  onchecked={(r) => (result = r as CheckData)}
/>

{#if result}
  <div class="mt-6 space-y-4">
    {#if result.notice}
      <p class="text-sm text-amber-300">{result.notice}</p>
    {/if}
    {#if result.skipped.length}
      <p class="whitespace-pre-wrap text-sm text-amber-300">
        Couldn't load: {result.skipped.map((s) => `${s.entityId} (${s.error})`).join(', ')}
      </p>
    {/if}
    {#if checkedWith !== changes.json}
      <p class="text-sm text-amber-300">
        The changes were edited after this check — check again to see their effect.
      </p>
    {/if}
    <!-- A new check starts every item's save form afresh, even where an item key repeats. -->
    {#key result}
      {#each result.items as item (item.key)}
        <CheckItem
          {item}
          entityType={result.entityType}
          labels={result.labels}
          testSets={data.testSets}
          {changedTitle}
          onedit={(key) => (editing = key)}
        />
      {/each}
    {/key}
  </div>
{/if}

<PromptEditor
  promptKey={editing}
  {changes}
  {current}
  currentError={data.active.ok ? null : data.active.error}
  onclose={() => (editing = null)}
/>
