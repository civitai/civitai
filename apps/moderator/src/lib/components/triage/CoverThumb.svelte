<script lang="ts">
  import { IconPhotoOff } from '@tabler/icons-svelte';
  import CdnOrRetractedMedia from '$lib/components/image-queue/CdnOrRetractedMedia.svelte';
  import { WITHHELD_REFUSED } from '$lib/held-media';
  import type { AppealCoverImage } from '$lib/server/minor-hash.service';

  let { image }: { image: AppealCoverImage } = $props();
</script>

{#if image.restricted}
  <div class="grid size-full place-items-center text-dark-2" title={WITHHELD_REFUSED}>
    <IconPhotoOff size={18} aria-label={WITHHELD_REFUSED} />
  </div>
{:else}
  <CdnOrRetractedMedia
    item={{ id: image.id, url: image.url, type: 'image' }}
    width={96}
    class="size-full object-cover"
  />
{/if}
