<script lang="ts">
  import { untrack } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import AccountHistory from '$lib/components/AccountHistory.svelte';
  import ImageEvidence from '$lib/components/report-queue/ImageEvidence.svelte';
  import ReadOnlyNotice from '$lib/components/report-queue/ReadOnlyNotice.svelte';
  import OwnerActions from '$lib/components/report-queue/OwnerActions.svelte';
  import ReportDetailColumns from '$lib/components/report-queue/ReportDetailColumns.svelte';
  import ReportList from '$lib/components/report-queue/ReportList.svelte';
  import { FormState } from '$lib/form-state.svelte';
  import EdgeMedia from '$lib/components/EdgeMedia.svelte';
  import { LINK_CLASS, dateTime, num, relativeTime } from '$lib/format';
  import {
    bulkImageManagerUrl,
    entityUrl,
    imageLookupUrl,
    modelVersionLookupUrl,
    postReportUrl,
    userLookupUrl,
  } from '$lib/entity-url';
  import { Tabs, TabsList, TabsTrigger } from '@civitai/ui/components/ui/tabs/index.js';
  import { getBrowsingLevelLabel } from '@civitai/shared';
  import { POST_TABS, POST_TAB_LABELS, type PostTab } from './tabs';
  import { clearPaging } from '$lib/paging';
  import {
    hasOpenReport,
    reportsForItem,
    advanceAfterRuling,
    itemHref,
    QUEUE_NAV,
    reportActionGrants,
  } from '$lib/report-queue';
  import type { LayoutData } from './$types';
  import type { PostItem } from './item.server';

  // The open post, rendered the same by the bare queue (its first post) and by `[postId]`: the post's
  // images and its owner's history as the evidence, every open report about it, and what to do about
  // the post's owner. Every form holds its own result (`FormState`); the page's `form` is not read.
  let { data }: { data: LayoutData & { item: PostItem | null } } = $props();

  const item = $derived(data.item);
  // Ruling and notes need only the queue; the images and the owner need their action grants.
  const can = $derived(reportActionGrants(data.grants));
  const lookup = $derived(item?.lookup ?? null);
  const reports = $derived(item ? reportsForItem(item.reports, data.items, item.postId) : []);

  // Which report is in flight, so one ruling does not disable every report's buttons.
  let pendingId = $state<number | null>(null);
  // Once the post has nothing left to rule, the queue moves on to the next one.
  const moveOn = advanceAfterRuling({
    items: () => data.items,
    currentId: () => item?.postId,
    hasOpen: () => hasOpenReport(reports),
    open: (id) => goto(itemHref(postReportUrl(id, page.params.tab), page.url.search), QUEUE_NAV),
  });
  const reportForm = new FormState({
    reload: true,
    onSubmit: ({ formData }) => {
      pendingId = Number(formData.get('id')) || null;
      moveOn.capture();
    },
    onSuccess: () => moveOn.advance(),
    onSettled: () => (pendingId = null),
  });

  // In the path with the post, so a link handed to a colleague opens the same view, and the queue (a
  // layout reading only its own params) does not reload under a tab click. Paging is dropped: it
  // indexes a list the other tabs do not have.
  function tabHref(next: PostTab) {
    const params = new URLSearchParams(page.url.search);
    clearPaging(params);
    const query = params.size ? `?${params}` : '';
    return `${postReportUrl(item?.postId ?? 0, next)}${query}`;
  }

  // Everything above belongs to the post it was raised on. The images and the owner's actions hold
  // their own state, and are keyed on the post below.
  let shownId: number | null = null;
  $effect.pre(() => {
    const id = item?.postId ?? null;
    if (id === shownId) return;
    shownId = id;
    untrack(() => {
      reportForm.error = null;
    });
  });
</script>

{#if item}
  {#snippet itemHeader()}
    <!-- The post IS the header: what it is, whose it is, and where else to open it. -->
    <header class="flex flex-col gap-1">
      <h2 class="m-0 flex flex-wrap items-center gap-2 text-lg font-semibold">
        {lookup?.post.title || `Post #${item.postId}`}
        {#if lookup?.post.tosViolation}<Badge variant="destructive">post ToS'd</Badge>{/if}
      </h2>
      {#if lookup}
        {@const blocked = lookup.images.filter((i) => i.ingestion === 'Blocked').length}
        <p class="m-0 text-sm text-muted-foreground">
          by
          <a href={userLookupUrl(lookup.post.username ?? lookup.post.userId)} class={LINK_CLASS}>
            {lookup.post.username ?? `#${lookup.post.userId}`}
          </a>
          {#if lookup.post.userBannedAt}<Badge variant="destructive">banned</Badge>{/if}
          {#if lookup.post.userCreatedAt}
            <span title={dateTime(lookup.post.userCreatedAt)}>
              (account {relativeTime(lookup.post.userCreatedAt)})
            </span>
          {/if}
          · {dateTime(lookup.post.createdAt)} · {num(lookup.total)} images{blocked
            ? `, ${num(blocked)} already blocked`
            : ''} ·
          <a href="{data.civitaiUrl}/posts/{item.postId}" target="_blank" rel="noreferrer" class={LINK_CLASS}>
            on the site
          </a>
        </p>
      {/if}
      {#if item.storylineChapter}
        {@const chapter = item.storylineChapter}
        <!-- A chapter judged alone, without the story it is part of, can pass where the story would not. -->
        <p class="m-0 flex flex-wrap items-center gap-2 text-sm" data-testid="post-storyline-chapter">
          <span>
            Chapter {chapter.number} of
            <a
              href={entityUrl(data.civitaiUrl, 'storyline', chapter.storylineId)}
              target="_blank"
              rel="noreferrer"
              class={LINK_CLASS}
            >
              {chapter.title}
            </a>
          </span>
          {#if chapter.minorByScan}<Badge variant="destructive">storyline minor-flagged</Badge>{/if}
          {#if chapter.tosViolation}<Badge variant="destructive">storyline taken down</Badge>{/if}
          {#if chapter.removed}<Badge variant="secondary">removed from storyline</Badge>{/if}
        </p>
      {/if}
    </header>
    <ReadOnlyNotice {can} owner={item?.ownerId != null} />
  {/snippet}

  <ReportDetailColumns header={itemHeader}>
    {#snippet evidence()}
      {#if lookup}
        <Tabs
          value={item.tab}
          onValueChange={(v) =>
            v && v !== item.tab && goto(tabHref(v as PostTab), { noScroll: true, keepFocus: true })}
          class="mb-4"
        >
          <TabsList>
            {#each POST_TABS as t (t)}
              <TabsTrigger value={t}>{POST_TAB_LABELS[t]}</TabsTrigger>
            {/each}
          </TabsList>
        </Tabs>
      {/if}
      {#if lookup}
        <!-- Hidden, not unmounted, on the other tabs: the selection and the last removal's result
             belong to the post, and a look at its details must not throw them away. -->
        {#key item.postId}
          <div class={item.tab === 'images' ? '' : 'hidden'}>
            <ImageEvidence
              images={lookup.images}
              {can}
              civitaiUrl={data.civitaiUrl}
              empty="This post has no images."
              truncated={lookup.truncated}
              endLabel="End of the post."
            />
            {#if item.ownerRecentImages.length}
              <section class="mt-6 border-t border-dark-4 pt-4">
                <h3 class="m-0 mb-2 flex flex-wrap items-baseline gap-2 text-sm font-semibold">
                  {lookup.post.username ?? 'The owner'}'s latest images outside this post
                  <a
                    href={bulkImageManagerUrl('user', lookup.post.userId)}
                    class="{LINK_CLASS} text-xs font-normal"
                  >
                    see all in Bulk Image Manager
                  </a>
                </h3>
                <div class="grid grid-cols-[repeat(auto-fill,minmax(110px,1fr))] gap-2">
                  {#each item.ownerRecentImages as img (img.id)}
                    <a
                      href={imageLookupUrl(img.id)}
                      class="block overflow-hidden rounded-md bg-dark-6"
                      title={dateTime(img.createdAt)}
                    >
                      <EdgeMedia
                        src={img.url}
                        type={img.type}
                        width={220}
                        class="aspect-square w-full object-cover"
                      />
                    </a>
                  {/each}
                </div>
              </section>
            {/if}
          </div>
        {/key}
      {/if}
      {#if lookup && item.tab === 'details'}
        {@const p = lookup.post}
        <!-- What the post says about itself and how it is shown — the half Bulk Image Manager does not
             have, and the half a spam or ToS report is often about. -->
        <dl class="m-0 grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
          <dt class="text-muted-foreground">Title</dt>
          <dd class="m-0 wrap-break-word">{p.title || '—'}</dd>
          <dt class="text-muted-foreground">Description</dt>
          <dd class="m-0 whitespace-pre-wrap wrap-break-word">{p.detail || '—'}</dd>
          <dt class="text-muted-foreground">Created</dt>
          <dd class="m-0">{dateTime(p.createdAt)}</dd>
          <dt class="text-muted-foreground">Published</dt>
          <dd class="m-0">{p.publishedAt ? dateTime(p.publishedAt) : 'Not published'}</dd>
          <dt class="text-muted-foreground">Shown</dt>
          <dd class="m-0">
            {p.availability}{p.unlisted ? ', unlisted' : ''} · rated {getBrowsingLevelLabel(p.nsfwLevel)}
            {#if p.tosViolation}<Badge variant="destructive">ToS'd</Badge>{/if}
          </dd>
          {#if p.modelVersionId}
            <dt class="text-muted-foreground">Posted to</dt>
            <dd class="m-0">
              <a href={modelVersionLookupUrl(p.modelVersionId)} class={LINK_CLASS}>
                model version #{p.modelVersionId}
              </a>
            </dd>
          {/if}
        </dl>
      {:else if lookup && item.tab === 'owner'}
        {#if item.ownerId != null && item.accountHistory}
          <!-- Whose post this is decides what a removal means: the owner's record goes with it. -->
          <AccountHistory userId={item.ownerId} civitaiUrl={data.civitaiUrl} {...item.accountHistory} />
        {/if}
      {:else if !lookup}
        <!-- A report outlives the post it is about. Without this the column would be empty and read
             as a failed load. -->
        <p class="text-sm text-dark-2">
          Post #{item.postId} no longer exists. Its reports can still be ruled on.
        </p>
      {/if}
    {/snippet}

    {#snippet actions()}
      <!-- 1. The reports: what was said, by whom, and the ruling on each. -->
      <ReportList
        {reports}
        canRule
        action="?/actionReport"
        onSubmit={reportForm.enhance}
        busyId={pendingId}
        error={reportForm.error}
      >
        {#snippet empty()}
          <p class="m-0 text-sm text-muted-foreground">No open reports on this post.</p>
        {/snippet}
      </ReportList>

      <!-- 2. The post's owner. The post itself is acted on in the image grid. -->
      {#if can.strike && item.ownerId != null}
        {#key item.postId}<OwnerActions userId={item.ownerId} />{/key}
      {/if}
    {/snippet}
  </ReportDetailColumns>
{:else}
  <p class="py-8 text-center text-sm text-muted-foreground">No reports match this view.</p>
{/if}
