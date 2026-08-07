<script lang="ts">
  import type { LayoutData } from './$types';
  import { userUrl } from '$lib/entity-url';
  import { LINK_CLASS, num } from '$lib/format';

  type Counts = NonNullable<LayoutData['result']>['counts'];

  let {
    counts,
    civitaiUrl,
    username,
  }: { counts: Counts; civitaiUrl: string; username: string | null } = $props();

  // Only link where the site has a page for that content type, and only when there is something to see.
  const href = (profilePath: string | null, count: number) =>
    profilePath && count > 0 && username
      ? userUrl(civitaiUrl, username, profilePath)
      : null;
</script>

<section class="mb-4 rounded-xl border border-dark-4 bg-dark-6 p-5">
  <h3 class="mb-3 text-sm font-semibold text-white">Content</h3>
  <div class="grid gap-3 sm:grid-cols-3 lg:grid-cols-4">
    {#each counts as item (item.label)}
      {@const link = href(item.profilePath, item.count)}
      <div>
        <div class="text-xl font-semibold tabular-nums text-white">
          {#if link}
            <a href={link} target="_blank" rel="noreferrer" class={LINK_CLASS}>{num(item.count)}</a>
          {:else}
            {num(item.count)}
          {/if}
        </div>
        <div class="text-xs text-dark-2">{item.label}</div>
      </div>
    {/each}
  </div>
</section>
