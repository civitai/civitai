<script lang="ts">
  import AppealImages from '$lib/components/minor-flags/AppealImages.svelte';
  import { LINK_CLASS } from '$lib/format';
  import type { AppealCoverImage } from '$lib/server/minor-hash.service';

  let {
    images,
    allHref,
  }: {
    images: AppealCoverImage[];
    /** Where every preview lives; omitted, the link is not shown. */
    allHref?: string;
  } = $props();

  const SHOWN = 4;
  const shown = $derived(images.slice(0, SHOWN));
</script>

<section aria-label="Preview images">
  <AppealImages images={shown} />
  {#if images.length}
    <div class="mt-2 flex items-center justify-between gap-3 text-sm text-dark-2">
      <span>
        {images.length} preview image{images.length === 1 ? '' : 's'}{images.length > SHOWN
          ? `, ${SHOWN} shown`
          : ''}
      </span>
      {#if allHref}
        <a href={allHref} target="_blank" rel="noreferrer" class={LINK_CLASS}>Open all previews</a>
      {/if}
    </div>
  {/if}
</section>
