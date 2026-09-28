<script lang="ts">
  import LookupSearch from '$lib/components/LookupSearch.svelte';
  import { LINK_CLASS } from '$lib/format';
  import type { PageData } from './$types';
  import ActivityPanel from './ActivityPanel.svelte';
  import EngagementPanel from './EngagementPanel.svelte';
  import ModelDetailPanel from './ModelDetailPanel.svelte';
  import ScanFlagPanel from './ScanFlagPanel.svelte';
  import VersionsPanel from './VersionsPanel.svelte';

  let { data }: { data: PageData } = $props();
</script>

<header class="page-header">
  <h1>Model Lookup</h1>
  <p>Find a model by ID or URL — its moderation state, its versions, and what has been reported.</p>
</header>

<LookupSearch q={data.q} placeholder="1234, a model URL, or a model-version URL" />

{#if data.notFound}
  <section class="rounded-xl border border-dark-4 bg-dark-6 p-5">
    <p class="text-sm text-dark-2">Nothing matches <code>{data.q || data.mv}</code>.</p>
  </section>
{:else if data.result}
  {@const result = data.result}
  {#if data.resolvedFromVersion}
    <section class="mb-4 rounded-xl border border-blue-500/30 bg-blue-500/10 p-4">
      <p class="text-sm text-blue-200">
        Version <code>#{data.resolvedFromVersion}</code> belongs to model
        <code>#{result.model.id}</code> — showing the model, with that version highlighted below.
      </p>
    </section>
  {/if}
  {#if data.alsoAVersion}
    <!-- The id is valid as both, and the model reading won. Without this the page is a confident answer
         to a question the moderator may not have asked — the other reading is one click away. -->
    <section class="mb-4 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4">
      <p class="text-sm text-amber-200">
        <code>#{data.alsoAVersion}</code> is also a model VERSION id. Showing the model —
        <a href="?mv={data.alsoAVersion}" class={LINK_CLASS}>open the version instead</a>.
      </p>
    </section>
  {/if}
  <!-- A `?q=` navigation does not remount, so an expanded raw-meta block would carry to the next model. -->
  {#key result.model.id}
    <ModelDetailPanel model={result.model} actors={result.actors} civitaiUrl={data.civitaiUrl} />
    <ScanFlagPanel flag={result.flag} model={result.model} />
    <VersionsPanel
      modelId={result.model.id}
      versions={result.versions}
      highlightVersionId={data.highlightVersionId}
      actors={result.actors}
      civitaiUrl={data.civitaiUrl}
    />
    <ActivityPanel reports={result.reports} modActivity={result.modActivity} />
    <EngagementPanel metrics={result.metrics} tags={result.tags} />
  {/key}
{/if}
