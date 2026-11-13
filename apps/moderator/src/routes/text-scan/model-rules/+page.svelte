<script lang="ts">
  import { page } from '$app/state';
  import LinkTabs from '$lib/components/LinkTabs.svelte';
  import { LINK_CLASS } from '$lib/format';
  import { urlWith } from '$lib/url';
  import AliasBackfill from './AliasBackfill.svelte';
  import RulesWorkspace from './RulesWorkspace.svelte';

  let { data } = $props();

  const canEdit = $derived(!!data.grants['textScan.modelRules.edit']);
  const backfill = $derived(canEdit && page.url.searchParams.get('view') === 'backfill');
  const views = $derived([
    { value: 'rules', label: 'Rules', href: urlWith(page.url, { view: null }) },
    { value: 'backfill', label: 'Alias backfill', href: urlWith(page.url, { view: 'backfill' }) },
  ]);
</script>

<svelte:head><title>Model rules · Text scan</title></svelte:head>

<div class="mb-4 flex flex-wrap items-baseline justify-between gap-2">
  <h1 class="text-xl font-semibold text-white">Model rules</h1>
  <a href="/models/rule-matches" class={LINK_CLASS}>Matches → Model rule matches</a>
</div>

{#if canEdit}
  <LinkTabs class="mb-4" items={views} active={backfill ? 'backfill' : 'rules'} />
{/if}

{#if backfill}
  <AliasBackfill rules={data.rules} userId={data.user?.id ?? 0} />
{:else}
  <RulesWorkspace
    rules={data.rules}
    dismissals={data.dismissals}
    query={data.query}
    {canEdit}
    userId={data.user?.id ?? 0}
    url={page.url}
  />
{/if}
