<script lang="ts">
  import type { Snippet } from 'svelte';
  import { IconExternalLink, IconFlag, IconUser } from '@tabler/icons-svelte';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import TriageDetailHeader from '$lib/components/triage/TriageDetailHeader.svelte';
  import { userLookupUrl } from '$lib/entity-url';
  import { modelUrl } from '$lib/minor-flags/appeal-row';
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
  const LINK_BUTTON =
    'h-[27px] gap-1.5 border-dark-4 bg-transparent px-2.5 text-xs font-normal text-dark-0 shadow-none dark:bg-transparent [&_svg]:size-[13px] [&_svg]:text-dark-1';
</script>

<TriageDetailHeader title={modelName} reference="#{modelId}" {chips}>
  {#snippet links()}
    <Button variant="outline" size="sm" class={LINK_BUTTON} {href} target="_blank" rel="noreferrer">
      <IconExternalLink aria-hidden="true" /> Open on Civitai
    </Button>
    <Button variant="outline" size="sm" class={LINK_BUTTON} href="/reports/model/{modelId}">
      <IconFlag aria-hidden="true" /> Reports{#await detail}{:then d}&nbsp;({d.openReports}){:catch}{/await}
    </Button>
    <Button variant="outline" size="sm" class={LINK_BUTTON} href={userLookupUrl(userId)}>
      <IconUser aria-hidden="true" /> Uploader
    </Button>
  {/snippet}
</TriageDetailHeader>
