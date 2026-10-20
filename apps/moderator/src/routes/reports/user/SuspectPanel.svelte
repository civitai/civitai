<script lang="ts">
  import { untrack } from 'svelte';
  import { goto } from '$app/navigation';
  import { page as pageState } from '$app/state';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Tabs, TabsList, TabsTrigger } from '@civitai/ui/components/ui/tabs/index.js';
  import { SelectionSet } from '@civitai/ui/hooks/selection-set.svelte.js';
  import { BlockedIds } from '$lib/blocked-ids.svelte';
  import { getBrowsingLevelLabel } from '@civitai/shared';
  import ImageQueueGrid from '$lib/components/ImageQueueGrid.svelte';
  import ImageFlagBadges from '$lib/components/ImageFlagBadges.svelte';
  import ImageActionBar from '$lib/components/ImageActionBar.svelte';
  import AccountHistory from '$lib/components/AccountHistory.svelte';
  import EdgeMedia from '$lib/components/EdgeMedia.svelte';
  import ProfileContent from '$lib/components/ProfileContent.svelte';
  import ContentCounts from '../../retool/user-lookup/ContentCounts.svelte';
  import SuspectFilterBar from './SuspectFilterBar.svelte';
  import SharedIpAccounts from '$lib/components/SharedIpAccounts.svelte';
  import DossierPanel from './DossierPanel.svelte';
  import { fetchSharedIpAccounts } from '../../retool/user-lookup/signals';
  import { browser } from '$app/environment';
  import { SSR_PENDING } from '$lib/ssr-pending';
  import { SUSPECT_TABS, SUSPECT_TAB_LABELS, type SuspectTab } from './tabs';
  import type { AccountData } from './account.server';
  import { FormState } from '$lib/form-state.svelte';
  import { LINK_CLASS, dateTime, num } from '$lib/format';
  import { entityUrl, modelLookupUrl, userLookupUrl, userReportUrl } from '$lib/entity-url';
  import { clearPaging, selectionKey } from '$lib/paging';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';
  import type { ReportActionGrants } from '$lib/report-queue';

  let {
    suspectId,
    tab,
    details,
    suspect,
    models,
    filters,
    accountHistory,
    can,
    civitaiUrl,
  }: {
    suspectId: number;
    tab: SuspectTab;
    details: NonNullable<AccountData['details']>;
    /** Each of these three is loaded only while its own tab is open, so null means "not this tab". */
    suspect: AccountData['suspect'];
    models: AccountData['models'];
    filters: AccountData['filters'];
    accountHistory: AccountData['accountHistory'];
    /** The viewer's action grants: the image bar needs `images`, its strike box `strike`. */
    can: ReportActionGrants;
    civitaiUrl: string;
  } = $props();

  // Derived, not fetched in an effect: a new account or tab is a new promise, and `SSR_PENDING` keeps
  // the server render in the same branch the browser hydrates.
  const sharedIps = $derived(
    browser ? (tab === 'details' ? fetchSharedIpAccounts(suspectId) : null) : SSR_PENDING
  );

  const selected = new SelectionSet<string | number>();

  // This panel owns its image writes so a success can clear the selection it armed. Strike and notify
  // moved to the report column beside it, with the report they answer.
  // What the server says it did — it can differ from what was asked (images already removed, a follow-up
  // that failed) — so the result line reports that rather than the request.
  let imageResult = $state<string | null>(null);
  let imageHeld = $state(false);
  const onSubmit = new FormState({
    reload: true,
    onSubmit: () => {
      imageResult = null;
      imageHeld = false;
    },
    onSuccess: (data) => {
      selected.clear();
      imageResult = typeof data?.imageResult === 'string' ? data.imageResult : null;
      imageHeld = data?.imageHeld === true;
    },
  });

  // The selection survives an image page turn and nothing else: any other URL change clears it. Keyed
  // on the URL, not `items`, a fresh array after ANY write that would discard a selection mid-assembly.
  // Blocked ids accumulate over the batch's pages because the selection spans them.
  const batchKey = $derived(selectionKey(pageState.url));
  const blockedIds = new BlockedIds();
  let shownBatch: string | undefined;
  $effect.pre(() => {
    const key = batchKey;
    const items = suspect?.items ?? [];
    untrack(() => {
      if (key !== shownBatch) {
        shownBatch = key;
        selected.clear();
        blockedIds.clear();
      }
      blockedIds.absorb(items);
    });
  });

  // In the path with the account, so a link handed to a colleague opens the same view — and so the
  // queue, a layout reading only its own params, does not reload under a tab click. The image page is
  // dropped: it indexes a grid the other tabs do not have.
  function tabHref(next: SuspectTab) {
    const params = new URLSearchParams(pageState.url.search);
    clearPaging(params);
    const query = params.size ? `?${params}` : '';
    return `${userReportUrl(suspectId, next)}${query}`;
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
    class="grid gap-6 lg:grid-cols-[minmax(0,1fr)_16rem]"
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

  <DossierPanel {suspectId} />

  <!-- The accounts sharing an address with this one, and the hand-off to Bulk Ban — for bots and
       the people running them. Client-fetched (`/api/shared-ip-accounts`): the shared-IP scan is the
       slow half of a lookup (~750ms against ClickHouse), and the profile should not wait on it. -->
  <section class="mt-6 border-t border-dark-4 pt-4">
    <h3 class="mb-2 text-sm font-semibold text-white">Accounts sharing its addresses</h3>
    {#await sharedIps}
      <p class="text-sm text-dark-2">Checking addresses…</p>
    {:then result}
      {#if result}
        <SharedIpAccounts accountId={suspectId} accounts={result.accounts} truncated={result.truncated} />
      {/if}
    {:catch}
      <p class="text-sm text-dark-2">Could not load the shared addresses.</p>
    {/await}
  </section>
{:else if tab === 'models' && models}
  <section>
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
  <section>
    <AccountHistory userId={suspectId} {civitaiUrl} {...accountHistory} />
  </section>
{:else if tab === 'images' && suspect}
  <!-- One toolbar card above the grid: the counts, the filters and the selection actions used to be
       three stacked cards, which pushed the first image most of a screen down. -->
  <section
    class="mb-4 rounded-lg border p-3 {selected.size > 0 ? 'border-blue-500/40 bg-blue-500/5' : ''}"
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
        <!-- Keyed on the URL, like the selection above: an unrelated write invalidates `load` and
             would otherwise reset a half-typed filter. -->
        {#key batchKey}
          <SuspectFilterBar {filters} />
        {/key}
      </div>
    {/if}

    {#if onSubmit.error}
      <ErrorAlert class="mt-3" message={onSubmit.error} />
    {:else if imageResult}
      <p class="mt-3 text-sm text-dark-0" role="status">
            {imageResult}
            {#if imageHeld}<a href="/images/re-removals" class="link ml-1">Open Re-removals</a>{/if}
          </p>
    {/if}

    {#if can.images}
      <div class="mt-3 border-t border-dark-4 pt-3">
        <ImageActionBar
          bare
          {selected}
          selectable={suspect.items.map((i) => i.id)}
          onSubmit={onSubmit.enhance}
          submitting={onSubmit.submitting}
          notify={false}
          strike={can.strike}
          {blockedIds}
          keepOffScreen
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
    selected={can.images ? selected : undefined}
    empty="No images match these filters."
    endLabel="End of this account's content."
    card={imageCard}
    minColumn={200}
    pagerTop
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
  approvedAppeal?: { approvedAt: Date; approvedByUsername: string | null } | null;
})}
  <div class="flex flex-col gap-1.5 p-2 text-xs text-dark-2">
    <div class="flex flex-wrap items-baseline gap-x-2 gap-y-1">
      <ImageFlagBadges
        ingestion={img.ingestion}
        blockedFor={img.blockedFor}
        tosViolation={img.tosViolation}
        needsReview={img.needsReview}
        approvedAppeal={img.approvedAppeal}
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
