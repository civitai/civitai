<script lang="ts">
  import { untrack } from 'svelte';
  import { goto } from '$app/navigation';
  import PromptWorkspace from '$lib/components/text-scan-lab/PromptWorkspace.svelte';
  import TryPanel from '$lib/components/text-scan-lab/TryPanel.svelte';
  import LabSideTabs from '$lib/components/text-scan-tests/LabSideTabs.svelte';
  import TestSetsPanel from '$lib/components/text-scan-tests/TestSetsPanel.svelte';
  import { denied } from '$lib/permissions';
  import { currentPromptsOf } from '$lib/text-scan-lab/changes';
  import { createChangesSync } from '$lib/text-scan-lab/changes.svelte';
  import { promptsHref } from '$lib/text-scan-lab/paths';
  import PromptKeyList from './PromptKeyList.svelte';

  let { data } = $props();

  const changes = createChangesSync(
    untrack(() => data.user?.id ?? 0),
    () => (data.prompts.ok ? currentPromptsOf(data.prompts.value) : null)
  );
  const canSave = $derived(!!data.grants['textScan.prompt.publish'] && data.prompts.ok);
  const canCapture = $derived(!!data.grants['textScan.testSets.edit']);
  const config = $derived(data.prompts.ok ? data.prompts.value.config : null);
</script>

<svelte:head><title>Prompts · Text scan</title></svelte:head>

<!-- 5.5rem = the layout's h-12 header + pb-10 under the page, so the cards end at the viewport. -->
<div class="lg:flex lg:h-[calc(100svh-5.5rem)] lg:flex-col">
  <div class="mb-4 flex flex-wrap items-baseline justify-between gap-2">
    <h1 class="text-xl font-semibold text-white">Prompts</h1>
    {#if config}
      <p class="text-xs text-dark-2">
        Model {config.model} · {config.maxInputChars.toLocaleString()} chars per call{config.maxSegments
          ? ` · up to ${config.maxSegments} calls`
          : ''} · thinking
        {config.thinking ? 'on' : 'off'}
      </p>
    {/if}
  </div>

  <div
    class="grid gap-4 lg:min-h-0 lg:flex-1 lg:grid-cols-[13rem_minmax(0,1fr)_minmax(0,1fr)] lg:grid-rows-[minmax(0,1fr)]"
  >
    <PromptKeyList
      active={data.key}
      {changes}
      latest={data.prompts.ok ? (data.prompts.value.latest ?? {}) : {}}
    />
    {#if data.prompts.ok}
      {#key data.key}
        <PromptWorkspace
          promptKey={data.key}
          {changes}
          prompts={data.prompts.value}
          authors={data.authors}
          {canSave}
          saveAction="?/save"
          restoreAction="?/restore"
          saveHint={denied('textScan.prompt.publish')}
        />
      {/key}
    {:else}
      <section class="rounded-xl border border-dark-4 bg-dark-6 p-5">
        <p class="text-sm text-red-300">{data.prompts.error}</p>
      </section>
    {/if}
    <div class="min-w-0 lg:overflow-y-auto">
      <LabSideTabs>
        {#snippet tryPanel()}
          <TryPanel
            prompts={changes.json}
            rules="[]"
            editedKeys={changes.keys}
            draftsError={changes.blankError}
            onedit={(key) => goto(promptsHref(key), { noScroll: true, keepFocus: true })}
            workspace="prompts"
            {canCapture}
          />
        {/snippet}
        {#snippet testSets(visible)}
          <TestSetsPanel
            workspace="prompts"
            {visible}
            prompts={changes.json}
            rules="[]"
            hasDraft={changes.keys.length > 0}
            draftsError={changes.blankError}
            canEdit={canCapture}
            userId={data.user?.id ?? 0}
          />
        {/snippet}
      </LabSideTabs>
    </div>
  </div>
</div>
