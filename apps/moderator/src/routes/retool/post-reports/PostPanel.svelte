<script lang="ts">
  import { untrack } from 'svelte';
  import { enhance } from '$app/forms';
  import { page as pageState } from '$app/state';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Textarea } from '@civitai/ui/components/ui/textarea/index.js';
  import { SvelteSet } from 'svelte/reactivity';
  import ImageQueueGrid from '$lib/components/ImageQueueGrid.svelte';
  import ImageFlagBadges from '$lib/components/ImageFlagBadges.svelte';
  import ImageActionBar from '$lib/components/ImageActionBar.svelte';
  import CannedReasonPicker from '$lib/components/CannedReasonPicker.svelte';
  import AccountHistory from '$lib/components/AccountHistory.svelte';
  import { STRIKE_REASONS } from '$lib/moderation-reasons';
  import type { PageData } from './$types';
  import { FormState } from '$lib/form-state.svelte';
  import { LINK_CLASS, dateTime, num } from '$lib/format';
  import { bulkImageManagerUrl, userLookupUrl } from '$lib/entity-url';
  import { nonPagingSearch } from '$lib/paging';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';

  let {
    lookup,
    ownerId,
    accountHistory,
    canAct,
    civitaiUrl,
    strikeError,
    notifyError,
    imagesError,
    imageResult,
  }: {
    lookup: NonNullable<PageData['lookup']>;
    ownerId: number;
    accountHistory: NonNullable<PageData['accountHistory']>;
    canAct: boolean;
    civitaiUrl: string;
    strikeError: string | null;
    notifyError: string | null;
    imagesError: string | null;
    imageResult: string | null;
  } = $props();

  let striking = $state(false);
  let strikeReason = $state('');
  let notifying = $state(false);

  const selected = new SvelteSet<string | number>();
  const blockedIds = $derived(
    new Set<string | number>(lookup.images.filter((i) => i.ingestion === 'Blocked').map((i) => i.id))
  );
  const blockedCount = $derived(lookup.images.filter((i) => i.ingestion === 'Blocked').length);

  // This panel owns its writes so a success can tear down what it armed.
  const onSubmit = new FormState({
    reload: true,
    onSuccess: () => {
      striking = false;
      notifying = false;
      selected.clear();
    },
  });

  // Same rule as the suspect grid: a new batch clears the selection, turning the page does not.
  // Inert while this grid has no paging, and correct the moment it gains some.
  const batchKey = $derived(nonPagingSearch(pageState.url.search));
  $effect(() => {
    batchKey;
    untrack(() => selected.clear());
  });
</script>

<section class="mb-4 rounded-xl border border-dark-4 bg-dark-6 p-5">
  <div class="mb-3 flex flex-wrap items-baseline justify-between gap-3">
    <div class="min-w-0">
      <h2 class="text-sm font-semibold text-white">
        Reported post · {num(lookup.total)} images
        {#if blockedCount > 0}
          <span class="font-normal text-dark-2">· {num(blockedCount)} already blocked</span>
        {/if}
        {#if lookup.post.tosViolation}
          <Badge variant="destructive">post ToS'd</Badge>
        {/if}
      </h2>
      <p class="text-xs text-dark-2">
        {#if lookup.post.title}<span class="text-dark-0">{lookup.post.title}</span> ·{/if}
        by
        <a href={userLookupUrl(lookup.post.username ?? ownerId)} class={LINK_CLASS}>
          {lookup.post.username ?? `#${ownerId}`}
        </a>
        {#if lookup.post.userBannedAt}<Badge variant="destructive">banned</Badge>{/if}
        · {dateTime(lookup.post.createdAt)}
        ·
        <a href="{civitaiUrl}/posts/{lookup.post.id}" target="_blank" rel="noreferrer" class={LINK_CLASS}>
          on the site
        </a>
        ·
        <!-- Past the cap this panel loads, Bulk Image Manager is the post page with paging on it. -->
        <a href={bulkImageManagerUrl('post', lookup.post.id)} class={LINK_CLASS}>
          in Bulk Image Manager
        </a>
      </p>
    </div>
    {#if canAct}
      <div class="flex gap-2">
        {#if !striking}
          <Button size="sm" variant="destructive" onclick={() => (striking = true)}>Strike</Button>
        {/if}
        {#if !notifying}
          <Button size="sm" onclick={() => (notifying = true)}>Notify</Button>
        {/if}
      </div>
    {/if}
  </div>

  {#if striking}
    <form method="POST" action="?/strike" use:enhance={onSubmit.enhance} class="mb-3">
      <input type="hidden" name="userId" value={ownerId} />
      {#if strikeError}
        <ErrorAlert class="mb-2" message={strikeError} />
      {/if}
      <CannedReasonPicker reasons={STRIKE_REASONS} idPrefix="strike" bind:value={strikeReason} />
      <div class="mt-2 flex gap-2">
        <Button type="submit" size="sm" variant="destructive" disabled={onSubmit.submitting}>
          {onSubmit.submitting ? 'Working…' : 'Issue strike'}
        </Button>
        <Button type="button" size="sm" variant="outline" onclick={() => (striking = false)}>
          Cancel
        </Button>
      </div>
    </form>
  {/if}

  {#if notifying}
    <form method="POST" action="?/notify" use:enhance={onSubmit.enhance} class="mb-3">
      <input type="hidden" name="userId" value={ownerId} />
      {#if notifyError}
        <ErrorAlert class="mb-2" message={notifyError} />
      {/if}
      <Textarea name="message" rows={2} placeholder="What should this user be told?" required />
      <div class="mt-2 flex gap-2">
        <Button type="submit" size="sm" disabled={onSubmit.submitting}>Send</Button>
        <Button type="button" size="sm" variant="outline" onclick={() => (notifying = false)}>
          Cancel
        </Button>
      </div>
    </form>
  {/if}

  <AccountHistory userId={ownerId} {civitaiUrl} {...accountHistory} />

  <h3 class="mb-2 text-xs tracking-wide text-dark-2 uppercase">The post's images</h3>
</section>

{#if imagesError}
  <ErrorAlert class="mb-3" message={imagesError} />
{:else if imageResult}
  <div class="mb-3 rounded-md border border-dark-4 bg-dark-6 p-2 text-sm text-dark-0" role="status">
    {imageResult}
  </div>
{/if}

{#if canAct}
  <ImageActionBar
    {selected}
    selectable={lookup.images.map((i) => i.id)}
    onSubmit={onSubmit.enhance}
    submitting={onSubmit.submitting}
    notify={false}
    blockedIds={blockedIds}
  />
{/if}

<ImageQueueGrid
  items={lookup.images}
  {civitaiUrl}
  selected={canAct ? selected : undefined}
  empty="This post has no images."
  endLabel={lookup.truncated ? null : 'End of the post.'}
  card={imageCard}
  minColumn={200}
/>

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
