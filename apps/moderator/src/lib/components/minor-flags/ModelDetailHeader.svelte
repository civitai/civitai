<script lang="ts">
  import type { Snippet } from 'svelte';
  import { IconExternalLink, IconFlag, IconUser } from '@tabler/icons-svelte';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import TriageDetailHeader from '$lib/components/triage/TriageDetailHeader.svelte';
  import { userLookupUrl } from '$lib/entity-url';
  import { modelUrl } from '$lib/minor-flags/appeal-row';

  let {
    modelId,
    modelName,
    userId,
    civitaiUrl,
    chips,
  }: {
    modelId: number;
    modelName: string;
    userId: number;
    civitaiUrl: string;
    chips: Snippet;
  } = $props();

  const href = $derived(modelUrl(civitaiUrl, modelId));
</script>

<TriageDetailHeader title={modelName} titleHref={href} reference="#{modelId}" {chips}>
  {#snippet links()}
    <Button variant="outline" size="sm" {href} target="_blank" rel="noreferrer">
      <IconExternalLink aria-hidden="true" /> Open on Civitai
    </Button>
    <Button variant="outline" size="sm" href="/reports/model/{modelId}">
      <IconFlag aria-hidden="true" /> Reports
    </Button>
    <Button variant="outline" size="sm" href={userLookupUrl(userId)}>
      <IconUser aria-hidden="true" /> Uploader
    </Button>
  {/snippet}
</TriageDetailHeader>
