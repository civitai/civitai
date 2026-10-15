<script lang="ts">
  import { untrack } from 'svelte';
  import { enhance } from '$app/forms';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Textarea } from '@civitai/ui/components/ui/textarea/index.js';
  import { SelectionSet } from '@civitai/ui/hooks/selection-set.svelte.js';
  import ImageQueueGrid from '$lib/components/ImageQueueGrid.svelte';
  import ImageFlagBadges from '$lib/components/ImageFlagBadges.svelte';
  import ImageActionBar from '$lib/components/ImageActionBar.svelte';
  import CannedReasonPicker from '$lib/components/CannedReasonPicker.svelte';
  import AccountHistory from '$lib/components/AccountHistory.svelte';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';
  import ReportDetailColumns from '$lib/components/report-queue/ReportDetailColumns.svelte';
  import ReportList from '$lib/components/report-queue/ReportList.svelte';
  import { STRIKE_REASONS } from '$lib/moderation-reasons';
  import { FormState } from '$lib/form-state.svelte';
  import { LINK_CLASS, dateTime, num } from '$lib/format';
  import {
    bulkImageManagerUrl,
    modelVersionLookupUrl,
    postReportUrl,
    userLookupUrl,
  } from '$lib/entity-url';
  import { Tabs, TabsList, TabsTrigger } from '@civitai/ui/components/ui/tabs/index.js';
  import { getBrowsingLevelLabel } from '@civitai/shared';
  import { POST_TABS, POST_TAB_LABELS, type PostTab } from './tabs';
  import { clearPaging } from '$lib/paging';
  import { hasOpenReport, nextItemId, reportsForItem } from '$lib/report-queue';
  import type { LayoutData } from './$types';
  import type { PostItem } from './item.server';

  // The open post, rendered the same by the bare queue (its first post) and by `[postId]`: the post's
  // images and its owner's history as the evidence, every open report about it, and what to do about
  // the post's owner. Every form holds its own result (`FormState`); the page's `form` is not read.
  let { data }: { data: LayoutData & { item: PostItem | null } } = $props();

  const item = $derived(data.item);
  const lookup = $derived(item?.lookup ?? null);
  const reports = $derived(item ? reportsForItem(item.reports, data.items, item.postId) : []);

  // Which report is in flight, so one ruling does not disable every report's buttons.
  let pendingId = $state<number | null>(null);
  let formerIndex = -1;
  const reportForm = new FormState({
    reload: true,
    onSubmit: ({ formData }) => {
      pendingId = Number(formData.get('id')) || null;
      formerIndex = data.items.findIndex((r) => r.entityId === item?.postId);
    },
    // Once the post has nothing left to rule, the queue moves on to the next one, as ruling a report
    // always moved it on to the next row. Read after the reload: the list is the new one.
    onSuccess: () => {
      if (!item || hasOpenReport(reports)) return;
      const next = nextItemId(data.items, formerIndex, item.postId);
      if (next == null) return;
      const params = new URLSearchParams(page.url.search);
      params.delete('report');
      clearPaging(params);
      const query = params.size ? `?${params}` : '';
      goto(`${postReportUrl(next, page.params.tab)}${query}`, { noScroll: true, keepFocus: true });
    },
    onSettled: () => (pendingId = null),
  });

  // The owner's two actions, one FormState each so a refusal shows in the row that was refused.
  let open = $state<'strike' | 'notify' | null>(null);
  let strikeReason = $state('');
  const strikeForm = new FormState({
    reload: true,
    onSuccess: () => {
      open = null;
      strikeReason = '';
    },
  });
  const notifyForm = new FormState({ reload: true, onSuccess: () => (open = null) });

  // The image writes clear the selection they armed, and report what the server says it did — it can
  // differ from what was asked (images already removed, a follow-up that failed).
  const selected = new SelectionSet<string | number>();
  let imageResult = $state<string | null>(null);
  const imageForm = new FormState({
    reload: true,
    onSubmit: () => (imageResult = null),
    onSuccess: (r) => {
      selected.clear();
      imageResult = typeof r?.imageResult === 'string' ? r.imageResult : null;
    },
  });
  const blockedIds = $derived(
    new Set<string | number>(
      (lookup?.images ?? []).filter((i) => i.ingestion === 'Blocked').map((i) => i.id)
    )
  );

  // In the path with the post, so a link handed to a colleague opens the same view, and the queue (a
  // layout reading only its own params) does not reload under a tab click. Paging is dropped: it
  // indexes a list the other tabs do not have.
  function tabHref(next: PostTab) {
    const params = new URLSearchParams(page.url.search);
    clearPaging(params);
    const query = params.size ? `?${params}` : '';
    return `${postReportUrl(item?.postId ?? 0, next)}${query}`;
  }

  // Everything above belongs to the post it was raised on.
  let shownId: number | null = null;
  $effect.pre(() => {
    const id = item?.postId ?? null;
    if (id === shownId) return;
    shownId = id;
    untrack(() => {
      for (const f of [reportForm, strikeForm, notifyForm, imageForm]) f.error = null;
      open = null;
      strikeReason = '';
      imageResult = null;
      selected.clear();
    });
  });
</script>

{#if item}
  <!-- The post IS the header: what it is, whose it is, and where else to open it. -->
  <header class="flex flex-col gap-1">
    <h2 class="m-0 flex flex-wrap items-center gap-2 text-lg font-semibold">
      {lookup?.post.title || `Post #${item.postId}`}
      {#if lookup?.post.tosViolation}<Badge variant="destructive">post ToS'd</Badge>{/if}
    </h2>
    {#if lookup}
      {@const blocked = blockedIds.size}
      <p class="m-0 text-sm text-muted-foreground">
        by
        <a href={userLookupUrl(lookup.post.username ?? lookup.post.userId)} class={LINK_CLASS}>
          {lookup.post.username ?? `#${lookup.post.userId}`}
        </a>
        {#if lookup.post.userBannedAt}<Badge variant="destructive">banned</Badge>{/if}
        · {dateTime(lookup.post.createdAt)} · {num(lookup.total)} images{blocked
          ? `, ${num(blocked)} already blocked`
          : ''} ·
        <a href="{data.civitaiUrl}/posts/{item.postId}" target="_blank" rel="noreferrer" class={LINK_CLASS}>
          on the site
        </a>
        ·
        <!-- Past the cap this panel loads, Bulk Image Manager is the post page with paging on it. -->
        <a href={bulkImageManagerUrl('post', item.postId)} class={LINK_CLASS}>in Bulk Image Manager</a>
      </p>
    {/if}
  </header>
  {#if !data.canAct}
    <p class="m-0 text-xs text-muted-foreground">
      Read-only: ruling on a report, removing images or acting on the owner needs access to the Users
      page (`/users`), granted on `/admin`.
    </p>
  {/if}

  <ReportDetailColumns>
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
      {#if lookup && item.tab === 'images'}
        {#if imageForm.error}
          <ErrorAlert class="mb-3" message={imageForm.error} />
        {:else if imageResult}
          <p class="mb-3 text-sm text-dark-0" role="status">{imageResult}</p>
        {/if}
        {#if data.canAct}
          <div class="mb-3">
            <ImageActionBar
              bare
              {selected}
              selectable={lookup.images.map((i) => i.id)}
              onSubmit={imageForm.enhance}
              submitting={imageForm.submitting}
              notify={false}
              {blockedIds}
            />
          </div>
        {/if}
        <ImageQueueGrid
          items={lookup.images}
          civitaiUrl={data.civitaiUrl}
          selected={data.canAct ? selected : undefined}
          empty="This post has no images."
          endLabel={lookup.truncated ? null : 'End of the post.'}
          card={imageCard}
          minColumn={200}
        />
      {:else if lookup && item.tab === 'details'}
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
        canRule={data.canAct}
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
      {#if data.canAct && item.ownerId != null}
        <section aria-labelledby="owner-heading" class="flex flex-col gap-2">
          <h3 id="owner-heading" class="m-0 text-sm font-semibold">Act on the owner</h3>
          <div class="divide-y rounded-lg border">
            <div class="flex flex-col gap-2 p-3">
              <div>
                <p class="m-0 text-sm font-medium">Strike</p>
                <p class="m-0 text-xs text-muted-foreground">
                  Records a strike with the reason the user is shown, and notifies them.
                </p>
              </div>
              {#if open === 'strike'}
                <form method="POST" action="?/strike" use:enhance={strikeForm.enhance} class="flex flex-col gap-2">
                  <input type="hidden" name="userId" value={item.ownerId} />
                  {#if strikeForm.error}<ErrorAlert message={strikeForm.error} />{/if}
                  <CannedReasonPicker reasons={STRIKE_REASONS} idPrefix="strike" bind:value={strikeReason} />
                  <div class="flex flex-wrap gap-2">
                    <Button type="submit" size="sm" variant="destructive" disabled={strikeForm.submitting}>
                      {strikeForm.submitting ? 'Working…' : 'Issue strike'}
                    </Button>
                    <Button type="button" size="sm" variant="ghost" onclick={() => (open = null)}>Cancel</Button>
                  </div>
                </form>
              {:else}
                <div><Button size="sm" variant="outline" onclick={() => (open = 'strike')}>Strike</Button></div>
              {/if}
            </div>

            <div class="flex flex-col gap-2 p-3">
              <div>
                <p class="m-0 text-sm font-medium">Notify</p>
                <p class="m-0 text-xs text-muted-foreground">Sends the user a message from the moderators.</p>
              </div>
              {#if open === 'notify'}
                <form method="POST" action="?/notify" use:enhance={notifyForm.enhance} class="flex flex-col gap-2">
                  <input type="hidden" name="userId" value={item.ownerId} />
                  {#if notifyForm.error}<ErrorAlert message={notifyForm.error} />{/if}
                  <Textarea name="message" rows={3} placeholder="What should this user be told?" required />
                  <div class="flex flex-wrap gap-2">
                    <Button type="submit" size="sm" disabled={notifyForm.submitting}>Send</Button>
                    <Button type="button" size="sm" variant="ghost" onclick={() => (open = null)}>Cancel</Button>
                  </div>
                </form>
              {:else}
                <div><Button size="sm" variant="outline" onclick={() => (open = 'notify')}>Notify</Button></div>
              {/if}
            </div>
          </div>
          <p class="m-0 text-xs text-muted-foreground">
            Muting, banning and the rest are in
            <a href={userLookupUrl(item.ownerId)} class="link">User Lookup</a>.
          </p>
        </section>
      {/if}
    {/snippet}
  </ReportDetailColumns>
{:else}
  <p class="py-8 text-center text-sm text-muted-foreground">No reports match this view.</p>
{/if}

{#snippet imageCard(img: {
  tosViolation?: boolean;
  needsReview?: string | null;
  createdAt?: Date;
  ingestion?: string;
  blockedFor?: string | null;
  poi?: boolean;
  minor?: boolean;
  prompt?: string | null;
  negativePrompt?: string | null;
  isProfilePicture?: boolean;
  hasConnection?: boolean;
})}
  <div class="flex flex-col gap-1.5 p-2 text-xs text-dark-2">
    <div class="flex flex-wrap items-baseline gap-x-2 gap-y-1">
      <ImageFlagBadges
        ingestion={img.ingestion}
        blockedFor={img.blockedFor}
        tosViolation={img.tosViolation}
        needsReview={img.needsReview}
        poi={img.poi}
        minor={img.minor}
      />
      <!-- Removing either has consequences beyond the image: one blanks the account's avatar, the
           other pulls an entry out of a bounty. -->
      {#if img.isProfilePicture}<Badge variant="secondary">profile picture</Badge>{/if}
      {#if img.hasConnection}<Badge variant="secondary">attached to entity</Badge>{/if}
      <span>{dateTime(img.createdAt ?? null)}</span>
    </div>
    {#if img.prompt}
      <p class="line-clamp-3 wrap-break-word" title={img.prompt}>{img.prompt}</p>
    {/if}
    {#if img.negativePrompt}
      <p class="line-clamp-2 wrap-break-word text-dark-2" title={img.negativePrompt}>
        neg: {img.negativePrompt}
      </p>
    {/if}
  </div>
{/snippet}
