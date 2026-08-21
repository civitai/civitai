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
  import SuspectFilterBar from './SuspectFilterBar.svelte';
  import type { PageData } from './$types';
  import { FormState } from '$lib/form-state.svelte';
  import { LINK_CLASS, dateTime, num } from '$lib/format';
  import { userLookupUrl } from '$lib/entity-url';
  import { nonPagingSearch } from '$lib/paging';

  let {
    suspectId,
    suspect,
    filters,
    accountHistory,
    canAct,
    civitaiUrl,
    strikeError,
    notifyError,
    imagesError,
    imageResult,
  }: {
    suspectId: number;
    suspect: NonNullable<PageData['suspect']>;
    filters: PageData['filters'];
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
    new Set<string | number>(
      suspect.items.filter((i) => i.ingestion === 'Blocked').map((i) => i.id)
    )
  );

  // This panel owns its writes so a success can tear down what it armed. Inferring that from the
  // action's return shape left a strike form open with a live submit after the strike had landed.
  const onSubmit = new FormState({
    reload: true,
    onSuccess: () => {
      striking = false;
      notifying = false;
      selected.clear();
    },
  });

  // Paging deliberately keeps the selection — one removal spans several pages of a 500-image account.
  // A filter change or a new suspect must not. Keyed on the search string, not `items`, which is a
  // fresh array after ANY write and would discard a selection mid-assembly.
  const batchKey = $derived(nonPagingSearch(pageState.url.search));
  $effect(() => {
    batchKey;
    untrack(() => selected.clear());
  });
</script>

<section class="mb-4 rounded-xl border border-dark-4 bg-dark-6 p-5">
  <div class="mb-3 flex flex-wrap items-baseline justify-between gap-3">
    <div>
      <h2 class="text-sm font-semibold text-white">
        Reported account · {num(suspect.total)} images
        {#if suspect.blocked > 0}
          <span class="font-normal text-dark-2">· {num(suspect.blocked)} already blocked</span>
        {/if}
      </h2>
      <p class="text-xs text-dark-2">
        {num(suspect.matched)} match the filters; showing {suspect.items.length} on this page.
        {#if suspect.total > suspect.blocked}
          {num(suspect.total - suspect.blocked)} remaining after prior enforcement.
        {/if}
        <a href={userLookupUrl(suspectId, 'reports')} class={LINK_CLASS}>
          Their reports in User Lookup
        </a>.
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
      <input type="hidden" name="userId" value={suspectId} />
      {#if strikeError}
        <div
          class="mb-2 rounded-md border border-red-500/30 bg-red-500/10 p-2 text-sm text-red-300"
          role="alert"
        >
          {strikeError}
        </div>
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
      <input type="hidden" name="userId" value={suspectId} />
      {#if notifyError}
        <div
          class="mb-2 rounded-md border border-red-500/30 bg-red-500/10 p-2 text-sm text-red-300"
          role="alert"
        >
          {notifyError}
        </div>
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

  <AccountHistory userId={suspectId} {civitaiUrl} {...accountHistory} />

  <h3 class="mb-2 text-xs tracking-wide text-dark-2 uppercase">Recent content</h3>
</section>

<!-- Keyed on the non-paging part, like the selection above: an unrelated write invalidates `load` and
     would otherwise reset a half-typed filter, and so would turning the page. -->
{#key batchKey}
  <SuspectFilterBar {filters} />
{/key}

{#if imagesError}
  <div
    class="mb-3 rounded-md border border-red-500/30 bg-red-500/10 p-2 text-sm text-red-300"
    role="alert"
  >
    {imagesError}
  </div>
{:else if imageResult}
  <div class="mb-3 rounded-md border border-dark-4 bg-dark-6 p-2 text-sm text-dark-0" role="status">
    {imageResult}
  </div>
{/if}

{#if canAct}
  <ImageActionBar
    {selected}
    selectable={suspect.items.map((i) => i.id)}
    onSubmit={onSubmit.enhance}
    submitting={onSubmit.submitting}
    notify={false}
    blockedIds={blockedIds}
  />
{/if}

<ImageQueueGrid
  items={suspect.items}
  {civitaiUrl}
  total={suspect.matched}
  perPage={suspect.perPage}
  page={suspect.page}
  selected={canAct ? selected : undefined}
  empty="No images match these filters."
  endLabel="End of this account's content."
  card={imageCard}
  minColumn={200}
/>

{#snippet imageCard(img: {
  tosViolation?: boolean;
  needsReview?: string | null;
  createdAt?: Date;
  ingestion?: string;
  blockedFor?: string | null;
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
