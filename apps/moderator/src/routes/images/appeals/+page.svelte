<script lang="ts">
  import ImageReviewGrid from '$lib/components/ImageReviewGrid.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  const fmt = (d: Date | string | null) => (d ? new Date(d).toLocaleDateString() : '');
</script>

<ImageReviewGrid
  title={data.title}
  items={data.items}
  level={data.level}
  civitaiUrl={data.civitaiUrl}
  nextCursor={data.nextCursor}
>
  {#snippet detail(item)}
    <div class="flex flex-col gap-1.5 rounded-md border border-sky-500/30 bg-sky-500/5 p-2 text-xs">
      <div>
        <span class="font-semibold text-rose-400">Removed:</span>
        {item.tosReason ?? item.blockedFor ?? 'TOS violation'}
        {#if item.removedAt}
          <span class="text-muted-foreground">
            · by {item.moderatorUsername ?? 'moderator'} · {fmt(item.removedAt)}
          </span>
        {/if}
      </div>
      <div>
        <span class="font-semibold text-sky-400">Appeal:</span>
        <span class="text-muted-foreground/90">{item.appeal.message}</span>
      </div>
      <div class="text-muted-foreground">
        by
        <a
          href={`${data.civitaiUrl}/user/${item.appeal.username}`}
          target="_blank"
          rel="noreferrer"
          class="hover:text-foreground">{item.appeal.username ?? '[deleted]'}</a
        >
        · {fmt(item.appeal.createdAt)}
      </div>
      {#if item.reports.length > 0}
        <div class="text-muted-foreground">
          Triggered by: {item.reports.map((r) => r.reason).join(', ')}
        </div>
      {/if}
    </div>
  {/snippet}
</ImageReviewGrid>
