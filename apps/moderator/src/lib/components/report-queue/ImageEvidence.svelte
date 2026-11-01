<script lang="ts">
  import { untrack } from 'svelte';
  import { page as pageState } from '$app/state';
  import { BlockedIds } from '$lib/blocked-ids.svelte';
  import { ImageOwners, type ImageOwner } from '$lib/image-owners.svelte';
  import { selectionKey } from '$lib/paging';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { SelectionSet } from '@civitai/ui/hooks/selection-set.svelte.js';
  import ImageQueueGrid from '$lib/components/ImageQueueGrid.svelte';
  import ImageFlagBadges from '$lib/components/ImageFlagBadges.svelte';
  import ImageActionBar from '$lib/components/ImageActionBar.svelte';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';
  import { FormState } from '$lib/form-state.svelte';
  import { enhance } from '$app/forms';
  import TipButton from '$lib/components/TipButton.svelte';
  import { imageFlagValue } from '$lib/image-flags';
  import { dateTime, num } from '$lib/format';
  import type { BulkImage } from '$lib/server/bulk-image.service';
  import type { ReportActionGrants } from '$lib/report-queue';

  /**
   * A reported item's images as evidence: the grid, and — for a moderator who may act — selection and
   * the remove/restore/flag bar, posting to the queue's shared image actions (`reportModerationActions`).
   * The post queue's images tab, and every shared-layout queue whose item has images.
   *
   * Holds its selection and result, so the page renders it inside `{#key}` on the item: a selection
   * made on one item must never be submitted against the next.
   */
  let {
    images,
    can,
    civitaiUrl,
    empty,
    truncated = false,
    endLabel = 'End of the images.',
    minColumn = 200,
    paging,
    owners: pageOwners,
  }: {
    images: BulkImage[];
    /** The viewer's action grants: the bar needs `images`, its strike-the-owners box `strike`. */
    can: ReportActionGrants;
    civitaiUrl: string;
    /** What an empty grid means for this item. */
    empty: string;
    /** More images than were read; the end-of-list line then does not claim to be the end. */
    truncated?: boolean;
    endLabel?: string;
    minColumn?: number;
    /** Numbered pages (`?imgPage=`), pager above and below, for an item with more images than one
     *  read holds. `page` is the server's, which clamps it. */
    paging?: { total: number; perPage: number; page: number };
    /** This page's image owners, for an item whose images span accounts: the strike box then names
     *  every owner the selection reaches instead of assuming one. */
    owners?: ImageOwner[];
  } = $props();

  // The writes clear the selection they armed, and report what the server says it did — it can differ
  // from what was asked (images already removed, a follow-up that failed).
  const selected = new SelectionSet<string | number>();
  let result = $state<string | null>(null);
  let held = $state(false);
  const form = new FormState({
    reload: true,
    onSubmit: () => {
      result = null;
      held = false;
    },
    onSuccess: (r) => {
      selected.clear();
      result = typeof r?.imageResult === 'string' ? r.imageResult : null;
      held = r?.imageHeld === true;
    },
  });
  // The selection survives an image page turn and nothing else: any other URL change clears it, and
  // the host's `{#key}` resets it per item. Blocked ids and owners accumulate over the pages shown,
  // since Restore's "not currently blocked" warning and the strike box must know about the ids carried
  // off earlier pages. The last write's result belongs to the page it was made on.
  const blockedIds = new BlockedIds();
  const owners = new ImageOwners();
  let shownKey: string | undefined;
  let shownPage: number | undefined;
  $effect.pre(() => {
    const key = selectionKey(pageState.url);
    const page = paging?.page;
    const items = images;
    const named = pageOwners;
    untrack(() => {
      if (key !== shownKey) {
        shownKey = key;
        selected.clear();
        blockedIds.clear();
        owners.clear();
      }
      if (page !== shownPage) {
        shownPage = page;
        result = null;
      }
      blockedIds.absorb(items);
      owners.absorb(items, named);
    });
  });
  const selectedOwners = $derived(owners.of(selected));
  const minorIds = $derived(images.filter((i) => i.minor).map((i) => i.id));
</script>

{#if form.error}
  <ErrorAlert class="mb-3" message={form.error} />
{:else if result}
  <p class="mb-3 text-sm text-dark-0" role="status">
    {result}
    {#if held}<a href="/images/re-removals" class="link ml-1">Open Re-removals</a>{/if}
  </p>
{/if}
{#if can.images && minorIds.length}
  <form method="POST" action="?/setFlag" use:enhance={form.enhance} class="mb-3">
    <input type="hidden" name="imageIds" value={minorIds.join(',')} />
    <TipButton
      type="submit"
      name="flagValue"
      value={imageFlagValue('minor', false)}
      size="sm"
      variant="outline"
      disabled={form.submitting}
      tip="Clear the minor flag on every minor-flagged image shown here. Selection is ignored."
    >
      Clear minor on {minorIds.length === 1 ? 'the flagged image' : `all ${num(minorIds.length)} flagged images`}{paging || truncated ? ' shown' : ''}
    </TipButton>
  </form>
{/if}
{#if can.images && images.length}
  <div class="mb-3">
    <ImageActionBar
      bare
      {selected}
      selectable={images.map((i) => i.id)}
      owners={selectedOwners}
      onSubmit={form.enhance}
      submitting={form.submitting}
      notify={false}
      strike={can.strike}
      {blockedIds}
      keepOffScreen={paging != null}
    />
  </div>
{/if}
<ImageQueueGrid
  items={images}
  {civitaiUrl}
  selected={can.images ? selected : undefined}
  {empty}
  endLabel={truncated ? null : endLabel}
  total={paging?.total}
  perPage={paging?.perPage}
  page={paging?.page}
  pagerTop={paging != null && paging.total > paging.perPage}
  card={imageCard}
  {minColumn}
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
  approvedAppeal?: { approvedAt: Date; approvedByUsername: string | null } | null;
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
        approvedAppeal={img.approvedAppeal}
      />
      <!-- Removing either has consequences beyond the image: one blanks the account's avatar, the
           other pulls it out of whatever it is attached to (a bounty entry, an article). -->
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
