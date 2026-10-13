<script lang="ts">
  import { page } from '$app/state';
  import LinkTabs from '$lib/components/LinkTabs.svelte';
  import { LINK_CLASS } from '$lib/format';
  import { promptsHref } from '$lib/text-scan-lab/paths';
  import MatchesTab from './MatchesTab.svelte';
  import RulesWorkspace from './RulesWorkspace.svelte';

  let { data } = $props();

  const canEdit = $derived(!!data.grants['textScan.modelRules.edit']);
  const TABS = [
    { value: 'rules', label: 'Rules', href: '?tab=rules' },
    { value: 'matches', label: 'Matches', href: '?tab=matches' },
  ];
</script>

<svelte:head><title>Model rules · Text scan</title></svelte:head>

<div class="mb-4 flex flex-wrap items-baseline justify-between gap-2">
  <h1 class="text-xl font-semibold text-white">Model rules</h1>
  <a href={promptsHref('label:modelRules')} class={LINK_CLASS}>Policy prompt on Prompts</a>
</div>

<LinkTabs class="mb-4" items={TABS} active={data.query.tab} />

{#if data.rules && data.policy}
  <RulesWorkspace
    rules={data.rules}
    policy={data.policy}
    authors={data.authors}
    query={data.query}
    {canEdit}
    userId={data.user?.id ?? 0}
    url={page.url}
  />
{:else if data.matches}
  <MatchesTab
    matches={data.matches}
    query={data.query}
    civitaiUrl={data.civitaiUrl}
    url={page.url}
  />
{/if}
