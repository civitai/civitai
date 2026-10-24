<script lang="ts">
  import { browser } from '$app/environment';
  import { SSR_PENDING } from '$lib/ssr-pending';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import WalkPager from '$lib/components/WalkPager.svelte';
  import { fetchJson } from '$lib/fetch-json';
  import { LINK_CLASS, dateTime, num } from '$lib/format';
  import type {
    ImageRemovalCounts,
    ImageRemovalCursor,
    ImageRemovalRow,
  } from '$lib/server/user-account.service';

  let { userId }: { userId: number } = $props();

  type Page = {
    rows: ImageRemovalRow[];
    next: ImageRemovalCursor | null;
    counts: ImageRemovalCounts;
  };

  // The cursors walked so far, so Previous is an index move. The panel remounts per account, so the
  // stack never carries one account's cursor into another's.
  let cursors = $state<(ImageRemovalCursor | null)[]>([null]);
  let index = $state(0);
  const cursor = $derived(cursors[index]);

  const page = $derived(
    browser
      ? fetchJson<Page>(
          `/api/user-mod-activity/${userId}?view=removals` +
            (cursor
              ? `&removedBefore=${encodeURIComponent(cursor.at)}&beforeId=${cursor.imageId}`
              : '')
        )
      : SSR_PENDING
  );

  const advance = (next: ImageRemovalCursor) => {
    cursors = [...cursors.slice(0, index + 1), next];
    index += 1;
  };
  const back = () => (index = Math.max(0, index - 1));

  const LABEL: Record<ImageRemovalRow['type'], string> = {
    DeleteTOS: 'Removed (ToS)',
    Delete: 'Deleted',
    Restore: 'Restored',
  };

  const actor = (row: ImageRemovalRow) =>
    row.actorId > 0 ? (row.actorUsername ?? `#${row.actorId}`) : 'system';
</script>

{#snippet pager(next: ImageRemovalCursor | null)}
  <WalkPager {index} hasNext={!!next} onBack={back} onNext={() => next && advance(next)} />
{/snippet}

<div class="mt-5 border-t border-dark-4 pt-4">
  <h4 class="mb-1 text-xs tracking-wide text-dark-2 uppercase">Image removals</h4>
  <p class="mb-2 text-xs text-dark-2">
    From the image event log, so it includes images already deleted from the site. Covers 2024 on;
    2023 events have no owner recorded. A Delete by someone other than the owner shows the actor's
    current role, since not every such actor is a moderator.
  </p>

  {#await page}
    <p class="text-sm text-dark-2">Loading image removals…</p>
  {:then p}
    {#if !p}
      <p class="text-sm text-dark-2">Loading image removals…</p>
    {:else}
      <p class="mb-2 text-xs text-dark-0">
        {num(p.counts.tos)} ToS removals · {num(p.counts.deletedByOthers)} deleted by others ·
        {num(p.counts.restored)} restored
      </p>
      {#if p.rows.length === 0}
        <p class="text-sm text-dark-2">
          {index > 0 ? 'No more removals.' : 'No image removals logged for this account.'}
        </p>
      {:else}
        <ul class="space-y-1.5 text-sm">
          {#each p.rows as row (row.key)}
            <li class="flex flex-wrap items-baseline gap-x-2">
              <span class="text-dark-2">{dateTime(row.at)}</span>
              <Badge variant={row.type === 'Restore' ? 'outline' : 'secondary'}>
                {LABEL[row.type]}
              </Badge>
              <a href="/retool/image-lookup?q={row.imageId}" class={LINK_CLASS}>
                image {row.imageId}
              </a>
              {#if row.violationType || row.tosReason}
                <span class="text-xs text-dark-0">{row.violationType ?? row.tosReason}</span>
              {/if}
              <span class="text-xs text-dark-2">
                by {actor(row)}
                {#if row.actorId > 0 && !row.actorIsModerator}(not a moderator){/if}
              </span>
            </li>
          {/each}
        </ul>
      {/if}
    {/if}
    {@render pager(p?.next ?? null)}
  {:catch e}
    <p class="text-sm text-red-300">Could not load image removals: {e.message}</p>
    {@render pager(null)}
  {/await}
</div>
