<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import type { PromptKey } from '$lib/text-scan-lab/types';
  import type { CheckResult } from './+page.server';
  import { changesStorageKey } from './changes';
  import { createChanges } from './changes.svelte';
  import ChangesBar from './ChangesBar.svelte';
  import CheckForm from './CheckForm.svelte';
  import CheckItem from './CheckItem.svelte';
  import PromptEditor from './PromptEditor.svelte';

  let { data } = $props();

  const current = $derived(data.active.ok ? data.active.content : {});
  const changes = createChanges(untrack(() => data.user?.id ?? 0));
  const currentPrompts = () =>
    data.active.ok ? { content: data.active.content, ids: data.active.ids } : null;

  let mounted = $state(false);
  onMount(() => {
    changes.restore(currentPrompts());
    mounted = true;
    const onStorage = (e: StorageEvent) => {
      if (e.key === null || e.key === changesStorageKey(data.user?.id ?? 0)) changes.reload();
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  });
  // After a publish reloads the page data: what went live stops being a change.
  $effect(() => {
    const next = currentPrompts();
    if (mounted) untrack(() => changes.setCurrent(next));
  });

  let result = $state<CheckResult | null>(null);
  let checkedWith = $state<string | null>(null);
  let editing = $state<PromptKey | null>(null);

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

{#if changes.keys.length}
  <ChangesBar
    {changes}
    canPublish={!!data.grants['textScan.prompt.publish'] && data.active.ok}
    onedit={(key) => (editing = key)}
  />
{/if}

<CheckForm
  overrides={changes.json}
  overridesError={changes.blankError}
  onstart={startCheck}
  onchecked={(r) => (result = r as CheckResult)}
/>

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
    {#each result.items as item (item.key)}
      <CheckItem {item} labels={result.labels} onedit={(key) => (editing = key)} />
    {/each}
  </div>
{/if}

<PromptEditor
  promptKey={editing}
  {changes}
  {current}
  currentError={data.active.ok ? null : data.active.error}
  onclose={() => (editing = null)}
/>
