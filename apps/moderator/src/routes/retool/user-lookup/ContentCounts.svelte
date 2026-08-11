<script lang="ts">
  import type { LayoutData } from './$types';
  import { userUrl } from '$lib/entity-url';
  import { LINK_CLASS, num } from '$lib/format';

  type Counts = NonNullable<LayoutData['result']>['counts'];

  let {
    counts,
    civitaiUrl,
    username,
    userId,
  }: { counts: Counts; civitaiUrl: string; username: string | null; userId: number } = $props();

  // In-app first. The public profile omits deleted, unpublished and TOS'd content, so a row that
  // counted 40 could open a page showing 12 — and the three comment/review rows linked nowhere at all.
  // Only link when there is something to see.
  const href = (item: Counts[number]) => {
    if (item.count === 0) return null;
    if (item.appSection)
      return item.appSection === 'bulk-image-manager'
        ? `/retool/bulk-image-manager?source=user&q=${userId}`
        : `/retool/user-lookup/${item.appSection}?q=${userId}`;
    return item.profilePath && username
      ? userUrl(civitaiUrl, username, item.profilePath)
      : null;
  };
</script>

<section class="mb-4 rounded-xl border border-dark-4 bg-dark-6 p-5">
  <h3 class="mb-3 text-sm font-semibold text-white">Content</h3>
  <div class="grid gap-3 sm:grid-cols-3 lg:grid-cols-4">
    {#each counts as item (item.label)}
      {@const link = href(item)}
      {@const external = !link?.startsWith('/')}
      <div>
        <div class="text-xl font-semibold tabular-nums text-white">
          {#if link}
            <a
              href={link}
              target={external ? '_blank' : null}
              rel={external ? 'noreferrer' : null}
              class={LINK_CLASS}
            >
              {num(item.count)}
            </a>
          {:else}
            {num(item.count)}
          {/if}
        </div>
        <div class="text-xs text-dark-2">{item.label}</div>
        <!-- Retool's per-flag breakdown. Only non-zero flags render: a row of zeroes is noise, and the
             absence of a flag here means none, since the query counts every row. -->
        {#if item.flags?.length}
          <div class="mt-0.5 flex flex-wrap gap-x-2 text-xs text-amber-300">
            {#each item.flags as f (f.label)}
              <span>{num(f.count)} {f.label}</span>
            {/each}
          </div>
        {/if}
      </div>
    {/each}
  </div>
</section>
