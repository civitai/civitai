<script lang="ts">
  import LinkTabs from '$lib/components/LinkTabs.svelte';
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

<LinkTabs
  class="mb-4"
  active={data.key}
  items={PROMPT_KEYS.map((key) => ({ value: key, label: promptKeyName(key), href: `?key=${key}` }))}
/>

{#if data.prompts.ok}
  <ActivePromptPanel promptKey={data.key} prompts={data.prompts.value} authors={data.authors} />
{:else}
  <section class="rounded-xl border border-dark-4 bg-dark-6 p-5">
    <p class="text-sm text-red-300">{data.prompts.error}</p>
  </section>
{/if}
