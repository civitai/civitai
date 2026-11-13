<script lang="ts">
  import { IconExternalLink } from '@tabler/icons-svelte';
  import PreviewImagesCard from '$lib/components/minor-flags/PreviewImagesCard.svelte';
  import TriageCard from '$lib/components/triage/TriageCard.svelte';
  import { LINK_CLASS } from '$lib/format';
  import { parentLabel, type HoldParent } from './hold-context';

  let {
    parent,
    href,
    blurred,
  }: { parent: HoldParent; href: string | null; blurred: boolean } = $props();

  const name = $derived(parent.title?.trim() || `#${parent.id}`);
</script>

<TriageCard dense title="Commented on">
  <p class="m-0 mb-2 text-[13px] text-dark-0">
    On {parentLabel(parent.type)}:
    {#if href}
      <a {href} target="_blank" rel="noreferrer" class={LINK_CLASS}>
        {name} <IconExternalLink class="inline size-3" aria-hidden="true" />
      </a>
    {:else}
      <span class="text-white">{name}</span>
    {/if}
  </p>
  {#if parent.images.length}
    <PreviewImagesCard
      images={parent.images}
      total={parent.imageTotal}
      {blurred}
      allHref={href ?? undefined}
    />
  {/if}
</TriageCard>
