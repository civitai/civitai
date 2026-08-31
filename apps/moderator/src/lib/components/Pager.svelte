<script lang="ts">
  import { LINK_CLASS, num } from '$lib/format';

  // Prefer `NumberedPager` (numbered pages) for a full-width table. This narrow prev/next form is for
  // a sidebar column where numbers do not fit.
  let {
    page: current,
    pageCount,
    href,
    total,
  }: {
    page: number;
    pageCount: number;
    href: (page: number) => string;
    /** Shown when the caller knows the row count; omitted rather than guessed. */
    total?: number;
  } = $props();
</script>

{#if pageCount > 1}
  <div class="mt-3 flex flex-wrap items-center gap-3 text-sm">
    {#if current > 1}
      <a href={href(current - 1)} class={LINK_CLASS}>← Previous</a>
    {/if}
    <span class="text-dark-2">
      Page {num(current)} of {num(pageCount)}{total === undefined ? '' : ` · ${num(total)} total`}
    </span>
    {#if current < pageCount}
      <a href={href(current + 1)} class={LINK_CLASS}>Next →</a>
    {/if}
  </div>
{/if}
