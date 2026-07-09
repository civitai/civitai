<script lang="ts">
  import ImageReviewGrid from '$lib/components/ImageReviewGrid.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  // Report.details is free-form JSON; surface a `comment` if the reporter left one.
  const comment = (details: unknown): string | null => {
    const c = (details as { comment?: unknown } | null)?.comment;
    return typeof c === 'string' && c.trim() ? c : null;
  };
</script>

<ImageReviewGrid
  title={data.title}
  items={data.items}
  level={data.level}
  civitaiUrl={data.civitaiUrl}
  nextCursor={data.nextCursor}
  keyOf={(item) => item.report.id}
>
  {#snippet detail(item)}
    <div class="rounded-md border border-amber-500/30 bg-amber-500/5 p-2 text-xs">
      <div class="flex items-center justify-between gap-2">
        <span class="font-semibold text-amber-400">{item.report.reason}</span>
        {#if item.report.count > 1}
          <span class="shrink-0 text-muted-foreground">+{item.report.count} others</span>
        {/if}
      </div>
      <div class="mt-0.5 text-muted-foreground">
        by
        <a
          href={`${data.civitaiUrl}/user/${item.report.username}`}
          target="_blank"
          rel="noreferrer"
          class="hover:text-foreground">{item.report.username ?? '[deleted]'}</a
        >
        · {new Date(item.report.createdAt).toLocaleDateString()}
      </div>
      {#if comment(item.report.details)}
        <p class="mt-1 line-clamp-3 text-muted-foreground/90">{comment(item.report.details)}</p>
      {/if}
    </div>
  {/snippet}
</ImageReviewGrid>
