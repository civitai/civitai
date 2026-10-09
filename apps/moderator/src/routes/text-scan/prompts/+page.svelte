<script lang="ts">
  import { cn } from '@civitai/ui/utils.js';
  import { promptKeyName } from '$lib/text-scan-lab/labels';
  import { PROMPT_KEYS } from '$lib/text-scan-lab/types';
  import ActivePromptPanel from './ActivePromptPanel.svelte';

  let { data } = $props();

  const config = $derived(data.prompts.ok ? data.prompts.value.config : null);
</script>

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
      href="?key={key}"
      class={cn(
        'rounded-md px-3 py-1 text-sm',
        key === data.key ? 'bg-dark-5 text-white' : 'text-dark-2 hover:bg-dark-6'
      )}
    >
      {promptKeyName(key)}
    </a>
  {/each}
</nav>

{#if data.prompts.ok}
  <ActivePromptPanel promptKey={data.key} prompts={data.prompts.value} authors={data.authors} />
{:else}
  <section class="rounded-xl border border-dark-4 bg-dark-6 p-5">
    <p class="text-sm text-red-300">{data.prompts.error}</p>
  </section>
{/if}
