<script lang="ts">
  import AppealImages from '$lib/components/minor-flags/AppealImages.svelte';
  import { LINK_CLASS } from '$lib/format';
  import { previewCountText } from '$lib/minor-flags/model-detail';
  import type { AppealCoverImage } from '$lib/server/minor-hash.service';

  let {
    images,
    allHref,
    total,
    blurred = false,
  }: {
    images: AppealCoverImage[];
    /** Where every preview lives; omitted, the link is not shown. */
    allHref?: string;
    total?: number;
    blurred?: boolean;
  } = $props();

  const SHOWN = 4;
  const shown = $derived(images.slice(0, SHOWN));
</script>

<section aria-label="Preview images">
  <AppealImages images={shown} {blurred} />
  {#if images.length}
    <div class="mt-1.5 flex items-center justify-between gap-3 text-[11px] text-dark-2">
      <span>
        {previewCountText(Math.max(total ?? 0, shown.length), shown.length)}
      </span>
      {#if allHref}
        <a href={allHref} target="_blank" rel="noreferrer" class={LINK_CLASS}>Open all previews</a>
      {/if}
    </div>
  {/if}
</section>
