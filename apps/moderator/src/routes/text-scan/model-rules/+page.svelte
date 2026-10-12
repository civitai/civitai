<script lang="ts">
  import { page } from '$app/state';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';
  import LinkTabs from '$lib/components/LinkTabs.svelte';
  import { LINK_CLASS } from '$lib/format';
  import MatchesTab from './MatchesTab.svelte';
  import RulesTab from './RulesTab.svelte';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  const canEdit = $derived(!!data.grants['textScan.modelRules.edit']);
  const TABS = [
    { value: 'rules', label: 'Rules', href: '?tab=rules' },
    { value: 'matches', label: 'Matches', href: '?tab=matches' },
  ];
  let editorOpen = $state(false);
</script>

<svelte:head><title>Model rules · Text scan</title></svelte:head>

<div class="mb-4 flex flex-wrap items-baseline justify-between gap-2">
  <h1 class="text-xl font-semibold text-white">Model rules</h1>
  <p class="flex gap-4 text-sm">
    <a href="/text-scan/check" class={LINK_CLASS}>Check a model against the rules</a>
    <a href="/text-scan/prompts?key=label:modelRules" class={LINK_CLASS}>Instructions history</a>
  </p>
</div>

<LinkTabs class="mb-4" items={TABS} active={data.query.tab} />

{#if form?.error && !editorOpen}
  <ErrorAlert class="mb-4" message={form.error} />
{:else if form?.message}
  <div class="mb-4 rounded-md border border-teal-500/30 bg-teal-500/10 p-2 text-sm text-teal-300">
    {form.message}
    {#if form.cacheWarning}<span class="text-amber-300">{form.cacheWarning}</span>{/if}
  </div>
{/if}

{#if data.rules}
  <RulesTab
    rules={data.rules}
    total={data.total}
    query={data.query}
    {canEdit}
    url={page.url}
    {form}
    bind:editorOpen
  />
{:else if data.matches}
  <MatchesTab
    matches={data.matches}
    query={data.query}
    civitaiUrl={data.civitaiUrl}
    url={page.url}
  />
{/if}
