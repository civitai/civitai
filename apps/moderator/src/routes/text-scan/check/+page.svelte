<script lang="ts">
  import { untrack } from 'svelte';
  import { beforeNavigate, goto } from '$app/navigation';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import type { PromptKey } from '$lib/text-scan-lab/types';
  import type { ChangesSource, CheckResult } from './+page.server';
  import type { ChangesInit } from './changes';
  import { createChanges } from './changes.svelte';
  import ChangesBar from './ChangesBar.svelte';
  import CheckForm from './CheckForm.svelte';
  import CheckItem from './CheckItem.svelte';
  import PromptEditor from './PromptEditor.svelte';
  import TestSetPanel from './TestSetPanel.svelte';

  let { data } = $props();

  const changesInit = (source: ChangesSource): ChangesInit => ({
    prompts: source.draft?.prompts ?? {},
    draftId: source.draft?.id ?? null,
    token: source.draft?.updatedAt.toISOString() ?? null,
    target: source.kind === 'draft' ? source.draft.id : null,
    editable: source.kind === 'mine' || source.editable,
  });

  let barError = $state<string | null>(null);
  const changes = createChanges(untrack(() => changesInit(data.changes)));
  const sourceKey = (source: ChangesSource) =>
    source.kind === 'draft' ? `draft:${source.draft.id}:${source.editable}` : 'mine';
  let loadedKey = untrack(() => sourceKey(data.changes));
  // Most reloads (a run, a saved case, a failed publish) leave the changes alone: resetting would drop
  // an edit still waiting to save. Reset for another draft, the conflict Reload, or a newer saved row
  // when nothing here is unsaved.
  $effect(() => {
    const next = changesInit(data.changes);
    const key = sourceKey(data.changes);
    untrack(() => {
      const replaced =
        !changes.dirty &&
        !changes.saving &&
        (next.draftId !== changes.draftId || (next.token ?? '') > (changes.token ?? ''));
      if (key === loadedKey && !changes.conflict && !replaced) return;
      loadedKey = key;
      changes.reset(next);
      barError = null;
    });
  });

  // Set while this page itself re-issues a navigation it held back to save first.
  let resuming = false;
  beforeNavigate((nav) => {
    if (resuming || !changes.dirty) return;
    if (nav.type === 'leave') {
      if (!changes.saveOnLeave()) nav.cancel();
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

  let result = $state<CheckResult | null>(null);
  let checkedWith = $state<string | null>(null);
  let editing = $state<PromptKey | null>(null);
  let casesSaved = $state(0);

  const current = $derived(data.active.ok ? data.active.content : {});
  const viewing = $derived(data.changes.kind === 'draft');
  const showBar = $derived(viewing || changes.keys.length > 0 || changes.dirty);
  const changedTitle = $derived(viewing ? 'With this draft' : 'With my changes');
  const saveSets = $derived(data.canSaveCase ? data.testSets : []);

  function startCheck() {
    result = null;
    checkedWith = changes.json;
  }
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
  onstart={startCheck}
  onchecked={(r) => (result = r as CheckResult)}
/>

{#if data.testSets.length}
  <TestSetPanel
    testSets={data.testSets}
    {changes}
    {changedTitle}
    changesName={viewing ? 'This draft' : 'Your changes'}
    civitaiUrl={data.civitaiUrl}
    openCase={data.openCase}
    onstart={startCheck}
    onchecked={(r) => (result = r)}
    casesSaved={casesSaved}
  />
{/if}

{#if result}
  <div id="check-results" class="mt-6 scroll-mt-4 space-y-4">
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
          testSets={saveSets}
          {changedTitle}
          onedit={(key) => (editing = key)}
          oncasesaved={() => casesSaved++}
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
