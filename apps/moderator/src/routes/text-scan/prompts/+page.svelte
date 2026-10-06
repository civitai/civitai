<script lang="ts">
  import { cn } from '@civitai/ui/utils.js';
  import RunTotals from '$lib/components/text-scan-lab/RunTotals.svelte';
  import { promptKeyName } from '$lib/text-scan-lab/labels';
  import { PROMPT_KEYS } from '$lib/text-scan-lab/types';
  import ActivePromptPanel from './ActivePromptPanel.svelte';
  import DraftEditor from './DraftEditor.svelte';
  import DraftsPanel from './DraftsPanel.svelte';
  import PublishPanel from './PublishPanel.svelte';

  let { data } = $props();

  const config = $derived(data.prompts.ok ? data.prompts.value.config : null);
  const active = $derived(data.prompts.ok ? data.prompts.value.active[data.key] : undefined);
  const keyHref = (key: string) => (data.draft ? `?draft=${data.draft.id}&key=${key}` : `?key=${key}`);
</script>

{#snippet publishPanel({ dirty }: { dirty: boolean })}
  {#if data.draft}
    <PublishPanel draft={data.draft} {dirty}>
      <RunTotals rows={data.runTotals} draftUpdatedAt={data.draft.updatedAt} />
    </PublishPanel>
  {/if}
{/snippet}

<svelte:head><title>Versions · Text scan</title></svelte:head>

<div class="mb-4 flex flex-wrap items-baseline justify-between gap-2">
  <h1 class="text-xl font-semibold text-white">Versions</h1>
  {#if config}
    <p class="text-xs text-dark-2">
      Model {config.model} · max input {config.maxInputChars.toLocaleString()} chars · thinking
      {config.thinking ? 'on' : 'off'}
    </p>
  {/if}
</div>

<nav class="mb-4 flex flex-wrap gap-1">
  {#each PROMPT_KEYS as key (key)}
    <a
      href={keyHref(key)}
      class={cn(
        'rounded-md px-3 py-1 text-sm',
        key === data.key ? 'bg-dark-5 text-white' : 'text-dark-2 hover:bg-dark-6'
      )}
    >
      {promptKeyName(key)}
    </a>
  {/each}
</nav>

<div class="grid gap-4 lg:grid-cols-2">
  <div>
    {#if data.prompts.ok}
      <ActivePromptPanel promptKey={data.key} prompts={data.prompts.value} authors={data.authors} />
    {:else}
      <section class="rounded-xl border border-dark-4 bg-dark-6 p-5">
        <p class="text-sm text-red-300">{data.prompts.error}</p>
      </section>
    {/if}
  </div>

  <div class="space-y-4">
    <DraftsPanel drafts={data.drafts} selectedId={data.draft?.id ?? null} promptKey={data.key} />

    {#if data.draft}
      {#key data.draft.id}
        <DraftEditor
          draft={data.draft}
          promptKey={data.key}
          {active}
          activeLoaded={data.prompts.ok}
          publish={data.grants['textScan.prompt.publish'] ? publishPanel : undefined}
        />
      {/key}
    {/if}
  </div>
</div>
