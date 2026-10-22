<script lang="ts">
  import { page } from '$app/state';
  import { LINK_CLASS } from '$lib/format';
  import RulesWorkspace from './RulesWorkspace.svelte';

  let { data } = $props();

  const canEdit = $derived(!!data.grants['textScan.modelRules.edit']);
</script>

<svelte:head><title>Model rules · Text scan</title></svelte:head>

<div class="mb-4 flex flex-wrap items-baseline justify-between gap-2">
  <h1 class="text-xl font-semibold text-white">Model rules</h1>
  <a href="/models/rule-matches" class={LINK_CLASS}>Matches → Model rule matches</a>
</div>

<RulesWorkspace
  rules={data.rules}
  dismissals={data.dismissals}
  query={data.query}
  {canEdit}
  userId={data.user?.id ?? 0}
  url={page.url}
/>
