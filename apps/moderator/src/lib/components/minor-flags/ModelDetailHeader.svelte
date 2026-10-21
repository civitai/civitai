<script lang="ts">
  import type { Snippet } from 'svelte';
  import { IconExternalLink, IconFlag, IconUser } from '@tabler/icons-svelte';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import TriageDetailHeader from '$lib/components/triage/TriageDetailHeader.svelte';
  import { userLookupUrl } from '$lib/entity-url';
  import { LINK_BUTTON } from '$lib/format';
  import { modelRef, modelUrl } from '$lib/minor-flags/appeal-row';
  import type { ModelFlagDetail } from '$lib/minor-flags/model-detail';

  let {
    modelId,
    modelName,
    userId,
    civitaiUrl,
    detail,
    chips,
  }: {
    modelId: number;
    modelName: string;
    userId: number;
    civitaiUrl: string;
    /** Carries the open-report count for the Reports link. */
    detail: Promise<ModelFlagDetail>;
    chips: Snippet;
  } = $props();

  const href = $derived(modelUrl(civitaiUrl, modelId));
</script>

<TriageDetailHeader title={modelName} reference={modelRef(modelId)} {chips} linksBeside>
  {#snippet links()}
    <Button variant="outline" size="sm" class={LINK_BUTTON} {href} target="_blank" rel="noreferrer">
      <IconExternalLink aria-hidden="true" /> Open on Civitai
    </Button>
    <Button variant="outline" size="sm" class={LINK_BUTTON} href="/reports/model/{modelId}">
      <IconFlag aria-hidden="true" /> Reports{#await detail}{:then d}&nbsp;({d.openReports}){:catch}&nbsp;<span title="Couldn't load the report count">(?)</span>{/await}
    </Button>
    <Button variant="outline" size="sm" class={LINK_BUTTON} href={userLookupUrl(userId)}>
      <IconUser aria-hidden="true" /> Uploader
    </Button>
  {/snippet}
</TriageDetailHeader>
