<script lang="ts">
  import { untrack } from 'svelte';
  import { enhance } from '$app/forms';
  import { goto } from '$app/navigation';
  import { page as pageState } from '$app/state';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Textarea } from '@civitai/ui/components/ui/textarea/index.js';
  import { Tabs, TabsList, TabsTrigger } from '@civitai/ui/components/ui/tabs/index.js';
  import { SelectionSet } from '@civitai/ui/hooks/selection-set.svelte.js';
  import { getBrowsingLevelLabel } from '@civitai/shared';
  import ImageQueueGrid from '$lib/components/ImageQueueGrid.svelte';
  import ImageFlagBadges from '$lib/components/ImageFlagBadges.svelte';
  import ImageActionBar from '$lib/components/ImageActionBar.svelte';
  import CannedReasonPicker from '$lib/components/CannedReasonPicker.svelte';
  import AccountHistory from '$lib/components/AccountHistory.svelte';
  import EdgeMedia from '$lib/components/EdgeMedia.svelte';
  import ProfileContent from '$lib/components/ProfileContent.svelte';
  import UserCard from '$lib/components/user-card/UserCard.svelte';
  import ContentCounts from '../user-lookup/ContentCounts.svelte';
  import { STRIKE_REASONS } from '$lib/moderation-reasons';
  import SuspectFilterBar from './SuspectFilterBar.svelte';
  import { SUSPECT_TABS, SUSPECT_TAB_LABELS, type SuspectTab } from './tabs';
  import type { PageData } from './$types';
  import { FormState } from '$lib/form-state.svelte';
  import { LINK_CLASS, dateTime, num } from '$lib/format';
  import { entityUrl, modelLookupUrl, userLookupUrl } from '$lib/entity-url';
  import { clearPaging, nonPagingSearch } from '$lib/paging';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';

  let {
    suspectId,
    tab,
    details,
    suspect,
    models,
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
    tab: SuspectTab;
    details: NonNullable<PageData['details']>;
    /** Each of these three is loaded only while its own tab is open, so null means "not this tab". */
    suspect: PageData['suspect'];
    models: PageData['models'];
    filters: PageData['filters'];
    accountHistory: PageData['accountHistory'];
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

  const selected = new SelectionSet<string | number>();
  const blockedIds = $derived(
    new Set<string | number>(
      (suspect?.items ?? []).filter((i) => i.ingestion === 'Blocked').map((i) => i.id)
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

  // In the URL like `user=`, so a link handed to a colleague opens the same view. The image page is
  // dropped: it indexes a grid the other tabs do not have.
  function tabHref(next: SuspectTab) {
    const params = new URLSearchParams(pageState.url.search);
    if (next === 'details') params.delete('tab');
    else params.set('tab', next);
    clearPaging(params);
    return `${pageState.url.pathname}?${params}`;
  }

  // How many image filters are on, for the collapsed toggle. Open by default only when some are, so a
  // filtered grid never hides why it is short.
  const filtersActive = $derived(
    [
      filters.tos,
      filters.noPrompt,
      filters.levels.length > 0,
      !!filters.from,
      !!filters.to,
      !!filters.prompt,
      !!filters.negativePrompt,
    ].filter(Boolean).length
  );
  let showFilters = $state(untrack(() => filtersActive > 0));

  const identity = $derived(details.card.identity);
  const hasProfile = $derived(
    !!(
      details.profile?.bio?.trim() ||
      details.profile?.message?.trim() ||
      details.profile?.location?.trim() ||
      details.profile?.coverImage ||
      details.profile?.sfwCoverImage ||
      identity.profilePictureUrl
    )
  );
</script>

<!-- Who this is, above every tab: the ban, mute and strike state decides what any tab's evidence
     means, and the enforcement buttons have to be reachable from whichever tab settled it. The card is
     its own box; wrapping it in a second one framed the header twice. -->
<UserCard card={details.card} lookupLink openReports={false} class="mb-3">
  {#snippet actions()}
    {#if canAct}
      {#if !striking}
        <Button size="sm" variant="destructive" onclick={() => (striking = true)}>Strike</Button>
      {/if}
      {#if !notifying}
        <Button size="sm" onclick={() => (notifying = true)}>Notify</Button>
      {/if}
    {/if}
  {/snippet}
</UserCard>

{#if striking || notifying}
  <section class="mb-3 rounded-xl border border-dark-4 bg-dark-6 p-4">
    {#if striking}
      <form method="POST" action="?/strike" use:enhance={onSubmit.enhance}>
        <input type="hidden" name="userId" value={suspectId} />
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
      <form method="POST" action="?/notify" use:enhance={onSubmit.enhance} class={striking ? 'mt-4' : ''}>
        <input type="hidden" name="userId" value={suspectId} />
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
  </section>
{/if}

<Tabs
  value={tab}
  onValueChange={(v) =>
    v && v !== tab && goto(tabHref(v as SuspectTab), { noScroll: true, keepFocus: true })}
  class="mb-4"
>
  <TabsList>
    {#each SUSPECT_TABS as t (t)}
      <TabsTrigger value={t}>{SUSPECT_TAB_LABELS[t]}</TabsTrigger>
    {/each}
  </TabsList>
</Tabs>

{#if tab === 'details'}
  <!-- One box, two columns: what the account says about itself on the left, what it has posted on
       the right. Three stacked boxes, each with its own dividers and headings, read as a form. -->
  <section
    class="mb-4 grid gap-6 rounded-xl border border-dark-4 bg-dark-6 p-5 lg:grid-cols-[minmax(0,1fr)_16rem]"
  >
    <div class="min-w-0">
      <h3 class="mb-3 text-sm font-semibold text-white">
        Profile
        {#if identity.createdAt}
          <span class="ml-1 text-xs font-normal text-dark-2">
            joined {dateTime(identity.createdAt)}
          </span>
        {/if}
      </h3>
      {#if hasProfile}
        <ProfileContent {identity} profile={details.profile} variant="plain" />
      {:else}
        <p class="text-sm text-dark-2">No profile text or media.</p>
      {/if}
    </div>
    <div class="min-w-0 lg:border-l lg:border-dark-4 lg:pl-6">
      <h3 class="mb-2 text-sm font-semibold text-white">Content</h3>
      <ContentCounts
        counts={details.counts}
        {civitaiUrl}
        username={identity.username}
        userId={suspectId}
        variant="list"
        linkOverride={(label) =>
          label === 'Models' ? tabHref('models') : label === 'Images' ? tabHref('images') : null}
      />
    </div>
  </section>
{:else if tab === 'models' && models}
  <section class="mb-4 rounded-xl border border-dark-4 bg-dark-6 p-5">
    <h3 class="mb-3 text-xs tracking-wide text-dark-2 uppercase">
      {num(models.items.length)}{models.truncated ? '+' : ''} models · newest first, deleted and unpublished
      included
    </h3>
    {#if models.items.length}
      <ul class="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-3">
        {#each models.items as m (m.id)}
          <!-- The cover opens the model on the site; a deleted one has no page there, so it goes to
               Model Lookup instead. The name always goes to Model Lookup. -->
          {@const siteUrl = m.deletedAt ? null : entityUrl(civitaiUrl, 'model', m.id)}
          <li class="overflow-hidden rounded-md border border-dark-4 bg-dark-7">
            <a
              href={siteUrl ?? modelLookupUrl(m.id)}
              target={siteUrl ? '_blank' : undefined}
              rel="noreferrer"
              class="block"
            >
              {#if m.coverUrl}
                <EdgeMedia
                  src={m.coverUrl}
                  type={m.coverType === 'video' ? 'video' : 'image'}
                  width={400}
                  alt="Cover for {m.name}"
                  class="aspect-[4/5] w-full object-cover"
                />
              {:else}
                <div class="flex aspect-[4/5] w-full items-center justify-center text-xs text-dark-2">
                  No images
                </div>
              {/if}
            </a>
            <div class="flex flex-col gap-1.5 p-2 text-xs">
              <a href={modelLookupUrl(m.id)} class="line-clamp-2 font-medium {LINK_CLASS}" title={m.name}>
                {m.name}
              </a>
              <div class="flex flex-wrap gap-1">
                <Badge variant="secondary">{m.type}</Badge>
                <Badge variant={m.status === 'Published' ? 'secondary' : 'outline'}>{m.status}</Badge>
                {#if m.deletedAt}<Badge variant="destructive">deleted</Badge>{/if}
                {#if m.mode}<Badge variant="outline">{m.mode}</Badge>{/if}
                {#if m.tosViolation}<Badge variant="destructive">ToS</Badge>{/if}
                {#if m.minor}<Badge variant="destructive">minor</Badge>{/if}
                {#if m.poi}<Badge variant="destructive">POI</Badge>{/if}
                {#if m.nsfwLevel}
                  <Badge variant={m.nsfwLevel >= 8 ? 'destructive' : 'secondary'}>
                    {getBrowsingLevelLabel(m.nsfwLevel)}
                  </Badge>
                {/if}
              </div>
              <span class="text-dark-2">{dateTime(m.createdAt)}</span>
            </div>
          </li>
        {/each}
      </ul>
    {:else}
      <p class="text-sm text-dark-2">This account has no models.</p>
    {/if}
    {#if models.truncated}
      <p class="mt-3 text-xs text-dark-2">
        Showing the newest {num(models.items.length)}.
        <a href={userLookupUrl(suspectId, 'content')} class={LINK_CLASS}>The rest in User Lookup</a>.
      </p>
    {/if}
  </section>
{:else if tab === 'activity' && accountHistory}
  <section class="mb-4 rounded-xl border border-dark-4 bg-dark-6 p-5">
    <AccountHistory userId={suspectId} {civitaiUrl} {...accountHistory} />
  </section>
{:else if tab === 'images' && suspect}
  <!-- One toolbar card above the grid: the counts, the filters and the selection actions used to be
       three stacked cards, which pushed the first image most of a screen down. -->
  <section
    class="mb-4 rounded-xl border p-4 {selected.size > 0
      ? 'border-blue-500/40 bg-blue-500/5'
      : 'border-dark-4 bg-dark-6'}"
  >
    <div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <p class="text-sm text-dark-2">
        <span class="font-semibold text-white">{num(suspect.total)} images</span>
        {#if suspect.blocked > 0}· {num(suspect.blocked)} already blocked{/if}
        {#if filtersActive}· {num(suspect.matched)} match the filters{/if}
      </p>
      <Button
        size="sm"
        variant="outline"
        aria-expanded={showFilters}
        onclick={() => (showFilters = !showFilters)}
      >
        Filters{filtersActive ? ` (${filtersActive})` : ''}
        <span aria-hidden="true">{showFilters ? '▴' : '▾'}</span>
      </Button>
    </div>

    {#if showFilters}
      <div class="mt-3 border-t border-dark-4 pt-3">
        <!-- Keyed on the non-paging part, like the selection above: an unrelated write invalidates
             `load` and would otherwise reset a half-typed filter, and so would turning the page. -->
        {#key batchKey}
          <SuspectFilterBar {filters} />
        {/key}
      </div>
    {/if}

    {#if imagesError}
      <ErrorAlert class="mt-3" message={imagesError} />
    {:else if imageResult}
      <p class="mt-3 text-sm text-dark-0" role="status">{imageResult}</p>
    {/if}

    {#if canAct}
      <div class="mt-3 border-t border-dark-4 pt-3">
        <ImageActionBar
          bare
          {selected}
          selectable={suspect.items.map((i) => i.id)}
          onSubmit={onSubmit.enhance}
          submitting={onSubmit.submitting}
          notify={false}
          {blockedIds}
        />
      </div>
    {/if}
  </section>

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
{/if}

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
