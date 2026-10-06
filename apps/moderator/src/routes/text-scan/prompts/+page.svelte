<script lang="ts">
  import { cn } from '@civitai/ui/utils.js';
  import { LINK_CLASS } from '$lib/format';
  import { scoreChips } from '$lib/text-scan-lab/score';
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

{#snippet runTotals()}
  <p class="mb-1">Latest finished test-set runs — for reference; they never block publishing.</p>
  {#each data.runTotals as row (row.setId)}
    {@const draftChips = row.draft ? scoreChips(row.draft.totals).join(' · ') || 'nothing scored' : 'not run'}
    {@const activeChips = row.active ? scoreChips(row.active.totals).join(' · ') || 'nothing scored' : 'not run'}
    {@const stale =
      row.draft?.draftUpdatedAt &&
      data.draft &&
      row.draft.draftUpdatedAt.getTime() !== data.draft.updatedAt.getTime()}
    <p>
      <a
        href="/text-scan/test-sets/{row.setId}{row.draft && row.active
          ? `?a=${row.active.runId}&b=${row.draft.runId}`
          : ''}"
        class={LINK_CLASS}>{row.setName}</a
      >
      — draft: <span class="text-dark-0">{draftChips}</span>{stale ? ' (draft edited since)' : ''}
      · active: <span class="text-dark-0">{activeChips}</span>
    </p>
  {/each}
{/snippet}

{#snippet publishPanel({ dirty }: { dirty: boolean })}
  {#if data.draft}
    <PublishPanel
      draft={data.draft}
      {dirty}
      totals={data.runTotals.length ? runTotals : undefined}
    />
  {/if}
{/snippet}

<svelte:head><title>Text-scan prompts</title></svelte:head>

<div class="mb-4 flex flex-wrap items-baseline justify-between gap-2">
  <h1 class="text-xl font-semibold text-white">Text-scan prompts</h1>
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
      {key}
    </a>
  {/each}
</nav>

<div class="grid gap-4 lg:grid-cols-2">
  <div>
    {#if data.prompts.ok}
      <ActivePromptPanel promptKey={data.key} prompts={data.prompts.value} />
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
          publish={data.grants['textScan.prompt.publish'] ? publishPanel : undefined}
        />
      {/key}
    {/if}
  </div>
</div>
