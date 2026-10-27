<script lang="ts">
  import { FormState } from '$lib/form-state.svelte';
  import { enhance } from '$app/forms';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Checkbox } from '@civitai/ui/components/ui/checkbox/index.js';
  import { Label } from '@civitai/ui/components/ui/label/index.js';
  import { Table, TableBody, TableCell, TableRow } from '@civitai/ui/components/ui/table/index.js';
  import { Tabs, TabsList, TabsTrigger } from '@civitai/ui/components/ui/tabs/index.js';
  import { SelectionCheckbox } from '@civitai/ui/components/selection/index.js';
  import { SelectionSet } from '@civitai/ui/hooks/selection-set.svelte.js';
  import { LINK_CLASS, dateTime, num, plainText } from '$lib/format';
  import { browser } from '$app/environment';
  import { keepLast } from '$lib/keep-last.svelte';
  import { postedIds } from './posted-ids';
  import {
    fetchReviewImageCounts,
    fetchReviews,
    type Account,
    type ReviewPage,
  } from './user-account';
  import ListCard from './ListCard.svelte';
  import ListFilterBar, { type FilterField } from '$lib/components/ListFilterBar.svelte';
  import NumberedPager from '$lib/components/NumberedPager.svelte';
  import ConfirmSubmit from '$lib/components/ConfirmSubmit.svelte';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';
  import SelectionBar from '$lib/components/SelectionBar.svelte';
  import TipButton from '$lib/components/TipButton.svelte';

  const YES_NO: [string, string][] = [
    ['yes', 'Yes'],
    ['no', 'No'],
  ];
  const RATINGS: [string, string][] = [1, 2, 3, 4, 5].map((n) => [String(n), `${n}★`]);

  // The selected owner stays listed when they fall out of the options — dropped, the control would read
  // "any" while still filtering.
  const ownerOptions = (owners: ReviewPage['owners'], selected: string | undefined) => {
    const options: [string, string][] = owners.map((o) => [
      String(o.id),
      `${o.username ?? `#${o.id}`} (${num(o.count)})`,
    ]);
    if (selected && !owners.some((o) => String(o.id) === selected))
      options.unshift([selected, `#${selected}`]);
    return options;
  };

  // Retool's select25 / select24 / select23 / select22 / textInput1, plus the model owner. Applied by
  // the server, so they cover every review rather than the page on screen.
  const writtenFields = (owners: ReviewPage['owners']): FilterField[] => [
    {
      kind: 'select',
      key: 'owner',
      label: 'Model owner',
      options: ownerOptions(owners, writtenFilters.owner),
    },
    { kind: 'select', key: 'rating', label: 'Rating', options: RATINGS },
    { kind: 'select', key: 'tos', label: 'ToS', options: YES_NO },
    { kind: 'select', key: 'nsfw', label: 'NSFW', options: YES_NO },
    { kind: 'select', key: 'exclude', label: 'Excluded', options: YES_NO },
    { kind: 'search', key: 'q', label: 'Search content' },
  ];
  const RECEIVED_FILTERS: FilterField[] = [
    { kind: 'select', key: 'rating', label: 'Rating', options: RATINGS },
    { kind: 'search', key: 'q', label: 'Search content' },
  ];

  // What posts is `postedIds` over the rendered rows, never the raw selection: a tick left on another
  // page or under an old filter must neither post nor be counted.
  const selectedReviews = new SelectionSet<number>();
  let writtenFilters = $state<Record<string, string>>({});
  let receivedFilters = $state<Record<string, string>>({});

  const filterReceived = (rows: Account['receivedReviews']['items']) =>
    rows.filter(
      (r) =>
        (!receivedFilters.rating || String(r.rating ?? '') === receivedFilters.rating) &&
        (!receivedFilters.q ||
          plainText(r.details).toLowerCase().includes(receivedFilters.q.toLowerCase()))
    );

  let {
    account,
    userId,
    canAct,
    civitaiUrl,
    onSuccess,
  }: {
    account: Promise<Account> | null;
    userId: number;
    canAct: boolean;
    civitaiUrl: string;
    onSuccess: () => void;
  } = $props();

  let refreshed = $state(0);
  let tab = $state<'written' | 'received'>('written');

  // Called through, not captured: reading the prop inside the closure is what stops a re-passed
  // callback being ignored (svelte’s `state_referenced_locally`).
  //
  // The selection is cleared here, as `CommentList` does. Exclude/Include leave their rows in the
  // list, so ticks left behind would silently join the NEXT action's payload.
  const form = new FormState({
    onSuccess: () => {
      selectedReviews.clear();
      onSuccess();
      refreshed++;
    },
  });
  const modelUrl = (modelId: number | null) => (modelId ? `${civitaiUrl}/models/${modelId}` : null);
  const uid = $props.id();

  const filterQuery = $derived(
    new URLSearchParams(Object.entries(writtenFilters).filter(([, v]) => v))
  );
  // A page is kept with the filters it was chosen under, so a filter change lands on page 1 with no
  // $effect to reset it.
  let paged = $state({ filters: '', page: 1 });
  const page = $derived(paged.filters === String(filterQuery) ? paged.page : 1);
  const goTo = (p: number) => (paged = { filters: String(filterQuery), page: p });

  const query = $derived.by(() => {
    const q = new URLSearchParams(filterQuery);
    q.set('page', String(page));
    return q;
  });
  // keep-last, not `{#await}`: a page turn or a filter keystroke would otherwise blank the table.
  const reviews = keepLast(() => (browser ? fetchReviews(userId, query, refreshed) : null));
  const imageCounts = keepLast(() =>
    browser ? fetchReviewImageCounts(userId, query, refreshed) : null
  );

  // Page-scoped both ways: unticking this page leaves ticks on other pages alone.
  function toggleAll(ids: number[], allSelected: boolean) {
    for (const id of ids) {
      if (allSelected) selectedReviews.delete(id);
      else selectedReviews.add(id);
    }
  }
</script>

<Tabs
  value={tab}
  onValueChange={(v) => v && (tab = v as typeof tab)}
  class="mb-3"
>
  <TabsList>
    <TabsTrigger value="written">
      Written{reviews.value ? ` (${num(reviews.value.all)})` : ''}
    </TabsTrigger>
    <TabsTrigger value="received">Received</TabsTrigger>
  </TabsList>
</Tabs>

<!-- Hidden rather than unmounted, so switching tabs keeps each list's filters, page and selection. -->
<section
  class="mb-4 rounded-xl border border-dark-4 bg-dark-6 p-5"
  class:hidden={tab !== 'written'}
>
  {#if reviews.value}
    {@const data = reviews.value}
    {@const rows = data.items}
    {@const visibleIds = rows.map((r) => r.id)}
    <!-- Ticks carry across pages and filters, and every tick posts. The bar says how many are not on
         screen, because Exclude/Include carry no confirmation to catch an unseen one. -->
    {@const posting = [...selectedReviews]}
    {@const onPage = postedIds(rows, selectedReviews).length}
    {@const allSelected = rows.length > 0 && onPage === rows.length}
    <h3 class="mb-3 text-sm font-semibold text-white">Reviews written ({num(data.all)})</h3>
    <ListFilterBar
      fields={writtenFields(data.owners)}
      bind:values={writtenFilters}
      matched={data.total}
      total={data.all}
    />
    {#if reviews.failed}
      <ErrorAlert class="mb-3" message="Could not load reviews — what is shown may be out of date." />
    {/if}
    {#if form.error && posting.length === 0}
      <!-- The bar shows an action's refusal while it is open; this catches one that lands after the
           selection was cleared. -->
      <ErrorAlert class="mb-3" message={form.error} />
    {/if}

    {#if rows.length === 0}
      <p class="text-sm text-dark-2">{data.total
          ? 'Nothing on this page.'
          : data.all
            ? 'No reviews match.'
            : 'None.'}</p>
    {:else}
      <form method="POST" action="?/contentAction" use:enhance={form.enhance}>
        <input type="hidden" name="userId" value={userId} />
        <input type="hidden" name="kind" value="reviews" />
        <!-- One entry per id: `contentAction` reads them with `form.getAll('reviewIds')`, and a
             joined string would act on a single row. Posted from the selection rather than from
             the controls themselves so the payload and the confirmed count are one derivation. -->
        {#each posting as id (id)}
          <input type="hidden" name="reviewIds" value={id} />
        {/each}

        {#if canAct}
          <div class="mb-2 flex items-center gap-2" data-touch-target>
            <Checkbox
              id="all-{uid}"
              bind:checked={() => allSelected, () => toggleAll(visibleIds, allSelected)}
              bind:indeterminate={() => onPage > 0 && !allSelected, () => {}}
            />
            <Label for="all-{uid}" class="text-xs font-normal text-dark-2">
              Select all {rows.length} on this page
            </Label>
          </div>
        {/if}

        <!-- Dimmed while a page turn or filter loads: the rows on screen are the previous answer, so
             Exclude and Include (which do not confirm) are off until the new one lands. -->
        <Table
          class="text-sm transition-opacity {reviews.loading ? 'opacity-50' : ''}"
          aria-busy={reviews.loading}
        >
          <TableBody>
            {#each rows as r (r.id)}
              <TableRow
                class="border-0 odd:bg-dark-7/40 hover:bg-dark-5/40"
                data-touch-target={canAct ? '' : undefined}
              >
                <TableCell class="whitespace-normal px-3 py-2.5">
                  <div class="flex gap-3">
                    {#if canAct}
                      <SelectionCheckbox
                        selection={selectedReviews}
                        key={r.id}
                        order={visibleIds}
                        aria-label="Select review {r.id}"
                        class="mt-0.5 shrink-0"
                      />
                    {/if}
                    <div class="min-w-0 flex-1">
                      <div class="flex items-baseline justify-between gap-2">
                        <div class="flex min-w-0 items-baseline gap-2">
                          <a
                            href={modelUrl(r.modelId)}
                            target="_blank"
                            rel="noreferrer"
                            class="truncate font-medium {LINK_CLASS}"
                          >
                            {r.modelName ?? `model ${r.modelId}`}
                          </a>
                          {#if r.rating !== null}
                            <span class="shrink-0 text-dark-0">{r.rating}★</span>
                          {/if}
                        </div>
                        <span class="shrink-0 text-xs text-dark-2">{dateTime(r.createdAt)}</span>
                      </div>
                      <div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-dark-2">
                        <span>
                          by <a href="?q={r.modelCreatorId}" class={LINK_CLASS}>
                            {r.modelCreator ?? `#${r.modelCreatorId}`}
                          </a>
                        </span>
                        {#if imageCounts.value?.[r.id]}
                          <span>{imageCounts.value[r.id]} img</span>
                        {/if}
                        {#if r.tosViolation}<Badge variant="destructive">ToS</Badge>{/if}
                        {#if r.nsfw}<Badge variant="secondary">NSFW</Badge>{/if}
                        {#if r.exclude}<Badge variant="secondary">excluded</Badge>{/if}
                      </div>
                      {#if r.details}
                        <p class="mt-1 wrap-break-word text-dark-1">{plainText(r.details)}</p>
                      {/if}
                    </div>
                  </div>
                </TableCell>
              </TableRow>
            {/each}
          </TableBody>
        </Table>

        {#if canAct}
          <SelectionBar
            count={posting.length}
            onclear={() => selectedReviews.clear()}
            clearDisabled={form.submitting}
          >
            {#snippet summary()}
              <span class="text-sm font-semibold text-white">{num(posting.length)} selected</span>
              {#if posting.length > onPage}
                <span class="text-sm text-amber-300">
                  · {num(posting.length - onPage)} not on this page
                </span>
              {/if}
            {/snippet}
            {#snippet actions()}
              <div class="ml-auto flex flex-wrap gap-2">
                <ConfirmSubmit
                  label="Delete"
                  name="op"
                  value="delete"
                  count={posting.length}
                  noun="review"
                  submitting={form.submitting}
                  tip="Permanently delete the selected reviews. Their ratings come off the model. Cannot be undone."
                />
                <TipButton
                  tip="Keep the reviews visible but stop them counting toward the model's rating, thumbs-up count and the creator's totals. Include undoes it."
                  type="submit"
                  name="op"
                  value="exclude"
                  size="sm"
                  variant="outline"
                  disabled={form.submitting || reviews.loading}
                  data-touch-target
                >
                  Exclude
                </TipButton>
                <TipButton
                  tip="Count the selected reviews toward ratings again. Undoes Exclude."
                  type="submit"
                  name="op"
                  value="include"
                  size="sm"
                  variant="outline"
                  disabled={form.submitting || reviews.loading}
                  data-touch-target
                >
                  Include
                </TipButton>
              </div>
            {/snippet}
            {#if form.error}
              <ErrorAlert message={form.error} />
            {/if}
          </SelectionBar>
        {/if}
      </form>
    {/if}
    <!-- Outside the empty branch: a delete can empty the last page, and the pager is the way back. -->
    <NumberedPager
      {page}
      total={data.total}
      perPage={data.perPage}
      label="reviews"
      onPageChange={goTo}
    />
  {:else if reviews.failed}
    <ErrorAlert message="Could not load reviews." />
  {:else}
    <p class="text-sm text-dark-2">Loading reviews…</p>
  {/if}
</section>

<section class="mb-4" class:hidden={tab !== 'received'}>
  {#await account}
    <div class="rounded-xl border border-dark-4 bg-dark-6 p-5">
      <p class="text-sm text-dark-2">Loading reviews received…</p>
    </div>
  {:then result}
    {#if result}
      {@const received = filterReceived(result.receivedReviews.items)}
      <ListCard
        title="Reviews received"
        total={received.length}
        capped={result.receivedReviews.truncated}
        hint="On this user's models, by others. A burst of 1★ from few accounts is the signal."
      >
        {#snippet controls()}
          <ListFilterBar
            fields={RECEIVED_FILTERS}
            bind:values={receivedFilters}
            matched={received.length}
            total={result.receivedReviews.items.length}
          />
        {/snippet}
        {#snippet children(limit)}
          <ul class="space-y-1 text-sm">
            {#each received.slice(0, limit) as r (r.id)}
              <li class="flex flex-wrap items-baseline gap-x-2">
                <a href="?q={r.reviewerId}" class={LINK_CLASS}>
                  {r.reviewer ?? `#${r.reviewerId}`}
                </a>
                {#if r.rating !== null}<span class="text-dark-0">{r.rating}★</span>{/if}
                {#if modelUrl(r.modelId)}
                  <a
                    href={modelUrl(r.modelId)}
                    target="_blank"
                    rel="noreferrer"
                    class="truncate {LINK_CLASS}"
                  >
                    {r.modelName ?? `model ${r.modelId}`}
                  </a>
                {/if}
                {#if r.exclude}<Badge variant="secondary">excluded</Badge>{/if}
                <span class="text-xs text-dark-2">{dateTime(r.createdAt)}</span>
                {#if r.details}
                  <p class="w-full wrap-break-word text-dark-1">{plainText(r.details)}</p>
                {/if}
              </li>
            {/each}
          </ul>
        {/snippet}
      </ListCard>
    {/if}
  {:catch}
    <div class="rounded-xl border border-dark-4 bg-dark-6 p-5">
      <ErrorAlert message="Could not load reviews received." />
    </div>
  {/await}
</section>
