<script lang="ts">
  import AppealImages from '$lib/components/minor-flags/AppealImages.svelte';
  import { LINK_CLASS } from '$lib/format';
  import { previewCountText, type ModelFlagDetail } from '$lib/minor-flags/model-detail';
  import type { AppealCoverImage } from '$lib/server/minor-hash.service';

  let {
    images,
    allHref,
    detail,
  }: {
    images: AppealCoverImage[];
    /** Where every preview lives; omitted, the link is not shown. */
    allHref?: string;
    /** Carries the model's true preview count; until it lands, the count is what the row holds. */
    detail: Promise<ModelFlagDetail>;
  } = $props();

  const SHOWN = 4;
  const shown = $derived(images.slice(0, SHOWN));
</script>

<section aria-label="Preview images">
  <AppealImages images={shown} />
  {#if images.length}
    <div class="mt-1.5 flex items-center justify-between gap-3 text-[11px] text-dark-2">
      <span>
        {#await detail}
          {previewCountText(shown.length, shown.length)}
        {:then d}
          {previewCountText(Math.max(d.previewCount, shown.length), shown.length)}
        {:catch}
          {previewCountText(shown.length, shown.length)}
        {/await}
      </span>
      {#if allHref}
        <a href={allHref} target="_blank" rel="noreferrer" class={LINK_CLASS}>Open all previews</a>
      {/if}
    </div>
  {/if}
</section>
