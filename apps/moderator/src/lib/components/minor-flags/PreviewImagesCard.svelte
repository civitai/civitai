<script lang="ts">
  import AppealImages from '$lib/components/minor-flags/AppealImages.svelte';
  import TriageCard from '$lib/components/triage/TriageCard.svelte';
  import { LINK_CLASS } from '$lib/format';
  import type { AppealCoverImage } from '$lib/server/minor-hash.service';

  let {
    images,
    total,
    modelHref,
  }: {
    images: AppealCoverImage[];
    /** How many previews the model has, when the queue knows it and it exceeds what is shown. */
    total?: number;
    modelHref?: string;
  } = $props();

  const count = $derived(total ?? images.length);
  const more = $derived(total !== undefined && total > images.length);
</script>

<TriageCard title="Preview images">
  {#if images.length}
    <p class="m-0 mb-3 text-sm text-dark-2">
      {count} preview image{count === 1 ? '' : 's'}
      {#if more && modelHref}
        · <a href={modelHref} target="_blank" rel="noreferrer" class={LINK_CLASS}>Open all ↗</a>
      {/if}
    </p>
  {/if}
  <AppealImages {images} />
</TriageCard>
