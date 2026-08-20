<script lang="ts">
  import LookupSearch from '$lib/components/LookupSearch.svelte';
  import type { PageData } from './$types';
  import ArticleDetailPanel from './ArticleDetailPanel.svelte';
  import MetricsPanel from './MetricsPanel.svelte';

  let { data }: { data: PageData } = $props();
</script>

<header class="page-header">
  <h1>Article Lookup</h1>
  <p>Find an article by ID or URL — its moderation state, scan status and engagement.</p>
</header>

<LookupSearch q={data.q} placeholder="123456, or a full article URL" />

{#if data.notFound}
  <section class="rounded-xl border border-dark-4 bg-dark-6 p-5">
    <p class="text-sm text-dark-2">No article matches <code>{data.q}</code>.</p>
  </section>
{:else if data.result}
  {@const result = data.result}
  <ArticleDetailPanel article={result.article} civitaiUrl={data.civitaiUrl} />
  <MetricsPanel metrics={result.metrics} />
{/if}
