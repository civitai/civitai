<script lang="ts">
  import { IconZoomCancel } from '@tabler/icons-svelte';
  import { page } from '$app/state';
  import { LINK_CLASS } from '$lib/format';
  import { urlWith } from '$lib/url';

  let { nothing, q, pick }: { nothing: string; q: string; pick: string } = $props();

  const clearSearchHref = $derived(urlWith(page.url, { q: null, page: null, selected: null }));
</script>

<div
  class="flex h-full flex-col items-center justify-center gap-1 p-5 text-center text-sm text-dark-0 in-[section]:hidden"
>
  <IconZoomCancel class="mb-1.5 size-5 text-dark-2" aria-hidden="true" />
  <p class="m-0 font-medium text-white">
    {nothing}{q ? ` match "${q}"` : ''}
  </p>
  <p class="m-0 text-xs text-dark-2">Search matches a song title, an owner username or an ID.</p>
  {#if q}
    <a href={clearSearchHref} class="text-xs {LINK_CLASS}">Clear search</a>
  {/if}
</div>
<p class="m-0 hidden text-sm text-dark-2 in-[section]:block">{pick}</p>
