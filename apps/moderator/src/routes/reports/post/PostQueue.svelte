<script lang="ts">
  import { enhance } from '$app/forms';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import ReportQueueColumn from '$lib/components/report-queue/ReportQueueColumn.svelte';
  import ReportRowMeta from '$lib/components/report-queue/ReportRowMeta.svelte';
  import { FormState } from '$lib/form-state.svelte';
  import type { LayoutData } from './$types';
  import { dateTime, num } from '$lib/format';
  import { postReportUrl, userLookupUrl } from '$lib/entity-url';
  import { itemHref, QUEUE_NAV } from '$lib/report-queue';

  let { data }: { data: LayoutData } = $props();

  // The open post is the child page's. Read through `page.data` because a layout's own `data` is only
  // its load's.
  const openPost = $derived(
    (page.data as { item?: { postId: number } | null }).item?.postId ?? null
  );

  // Opening a post keeps the queue page, the filters and the open tab; a single-report view does not
  // survive it.
  function open(postId: number | null) {
    if (postId == null) return;
    goto(itemHref(postReportUrl(postId, page.params.tab), page.url.search), QUEUE_NAV);
  }

  // A bulk action that reports nothing is indistinguishable from one that did nothing, so the sweep
  // says what it changed — the server's count, not the number of ids it found.
  let swept = $state<string | null>(null);
  const sweepForm = new FormState({
    reload: true,
    onSubmit: () => (swept = null),
    onSuccess: (r) => {
      if (!r) return;
      swept = `Actioned ${r.actioned} of ${r.found}${r.skipped ? `, ${r.skipped} already handled` : ''}${r.more ? ' — more remain, run it again.' : ''}`;
    },
  });
</script>

<ReportQueueColumn
  basePath="/reports/post"
  queue={data}
  items={data.items}
  isOpen={(r) => r.entityId != null && r.entityId === openPost}
  onOpen={(r) => open(r.entityId)}
  dates
>
  {#snippet toolbar()}
    <!-- Retool's `ActionAllPostReports`: the query keys on every image in the post already being
         blocked, which is a post-shaped question — so it lives on this queue alone. A ruling, so it
         needs only the queue. -->
    <form
      method="POST"
      action="?/actionResolvedPosts"
      use:enhance={sweepForm.enhance}
      class="flex flex-col gap-1"
    >
      <Button type="submit" size="sm" variant="outline" class="self-start" disabled={sweepForm.submitting}>
        Action reports already resolved by content
      </Button>
      <span class="text-xs text-muted-foreground">
        Pending reports whose post is entirely blocked already.
      </span>
      {#if sweepForm.error}
        <p class="m-0 text-xs text-red-300" role="alert">{sweepForm.error}</p>
      {:else if swept}
        <p class="m-0 text-xs text-green-300" role="status">{swept}</p>
      {/if}
    </form>
  {/snippet}

  {#snippet row(r)}
    {@const p = r.post}
    <!-- The post first, as the other queues lead with the account or the model; "banned" sits on this
         line because it is what a moderator scans the queue for. -->
    <div class="flex items-baseline justify-between gap-2">
      <span class="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
        <span class="font-medium">{p?.title || `Post #${r.entityId ?? '—'}`}</span>
        {#if p?.username}
          <a href={userLookupUrl(p.username)} class="link text-xs">{p.username}</a>
        {/if}
        {#if p?.bannedAt}<Badge variant="destructive">banned</Badge>{/if}
      </span>
      <span class="shrink-0 whitespace-nowrap text-xs text-muted-foreground">
        {dateTime(r.createdAt)}
      </span>
    </div>
    <ReportRowMeta report={r}>
      {#if p == null}
        <!-- A report survives its post's deletion. Saying so is what stops a moderator reading the
             empty panel as a broken page. -->
        <Badge variant="secondary">post deleted</Badge>
      {:else}
        <span class="text-muted-foreground">
          {num(p.imageCount - p.blockedCount)} of {num(p.imageCount)} images left
        </span>
        {#if p.imageCount > 0 && p.blockedCount === p.imageCount}
          <span class="text-emerald-300">resolved by content</span>
        {/if}
      {/if}
    </ReportRowMeta>
  {/snippet}
</ReportQueueColumn>
