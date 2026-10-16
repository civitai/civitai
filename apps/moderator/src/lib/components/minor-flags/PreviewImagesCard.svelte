<script lang="ts">
  import AppealImages from '$lib/components/minor-flags/AppealImages.svelte';
  import TriageCard from '$lib/components/triage/TriageCard.svelte';
  import type { AppealCoverImage } from '$lib/server/minor-hash.service';

  let { images }: { images: AppealCoverImage[] } = $props();
</script>

<TriageCard title="Preview images">
  {#if images.length}
    <p class="m-0 mb-3 text-sm text-dark-2">
      {images.length} preview image{images.length === 1 ? '' : 's'}
    </p>
  {/if}
  <AppealImages {images} />
</TriageCard>
