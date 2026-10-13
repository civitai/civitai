<script lang="ts">
  import { untrack } from 'svelte';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import TryPanel from '$lib/components/text-scan-lab/TryPanel.svelte';
  import { createChangesSync } from '$lib/text-scan-lab/changes.svelte';
  import type { PromptKey } from '$lib/text-scan-lab/types';
  import ChangesBar from './ChangesBar.svelte';
  import PromptEditor from './PromptEditor.svelte';

  let { data } = $props();

  const current = $derived(data.active.ok ? data.active.content : {});
  const changes = createChangesSync(untrack(() => data.user?.id ?? 0), () =>
    data.active.ok ? { content: data.active.content, ids: data.active.ids } : null
  );
  let editing = $state<PromptKey | null>(null);
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

<TryPanel
  prompts={changes.json}
  rules="[]"
  editedKeys={changes.keys}
  only={null}
  draftsError={changes.blankError}
  onedit={(key) => (editing = key)}
/>

<PromptEditor
  promptKey={editing}
  {changes}
  {current}
  currentError={data.active.ok ? null : data.active.error}
  onclose={() => (editing = null)}
/>
