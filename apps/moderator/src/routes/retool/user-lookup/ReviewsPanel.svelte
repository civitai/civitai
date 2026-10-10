<script lang="ts">
  import { FormState } from '$lib/form-state.svelte';
  import { enhance } from '$app/forms';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { SelectionCheckbox } from '@civitai/ui/components/selection/index.js';
  import { SelectionSet } from '@civitai/ui/hooks/selection-set.svelte.js';
  import { LINK_CLASS, dateTime, plainText } from '$lib/format';
  import { postedIds } from './posted-ids';
  import type { Account } from './user-account';
      import ListCard from './ListCard.svelte';
  import ListFilterBar, { type FilterField } from '$lib/components/ListFilterBar.svelte';
  import ConfirmSubmit from '$lib/components/ConfirmSubmit.svelte';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';

  const YES_NO: [string, string][] = [
    ['yes', 'Yes'],
    ['no', 'No'],
  ];
  const RATINGS: [string, string][] = [1, 2, 3, 4, 5].map((n) => [String(n), `${n}★`]);

  // Retool's select25 / select24 / select23 / select22 / textInput1.
  const WRITTEN_FILTERS: FilterField[] = [
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

  // A `SelectionSet`, not an array behind `bind:group` — `bind:group` only works on a native
  // `<input>`. What it fixes: under `bind:group` the COUNT and the PAYLOAD were different quantities.
  // A row ticked and then filtered off screen stayed in `selectedReviews.length`, which is what
  // Delete's confirmation read, while its input had unmounted and stopped posting. Both now come from
  // one derivation over the rendered rows, so they cannot disagree.
  //
  // Only that derivation (`postedIds`) is shared with `CommentList.svelte` beside this file — it keeps
  // its own array-based selection, so comments get no shift-range select. Unifying the two selection
  // models is a follow-up, not this change.
  const selectedReviews = new SelectionSet<number>();
  let writtenFilters = $state<Record<string, string>>({});
  let receivedFilters = $state<Record<string, string>>({});

  const bool = (v: boolean | null | undefined) => (v ? 'yes' : 'no');
  const matches = (
    f: Record<string, string>,
    r: { rating?: number | null; details?: string | null }
  ) =>
    (!f.rating || String(r.rating ?? '') === f.rating) &&
    (!f.q || plainText(r.details).toLowerCase().includes(f.q.toLowerCase()));

  const filterWritten = (rows: Account['reviews']['items']) =>
    rows.filter(
      (r) =>
        matches(writtenFilters, r) &&
        (!writtenFilters.tos || bool(r.tosViolation) === writtenFilters.tos) &&
        (!writtenFilters.nsfw || bool(r.nsfw) === writtenFilters.nsfw) &&
        (!writtenFilters.exclude || bool(r.exclude) === writtenFilters.exclude)
    );
  const filterReceived = (rows: Account['receivedReviews']['items']) =>
    rows.filter((r) => matches(receivedFilters, r));

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

  // Called through, not captured: reading the prop inside the closure is what stops a re-passed
  // callback being ignored (svelte’s `state_referenced_locally`).
  //
  // The selection is cleared here, as `CommentList` does. Exclude/Include leave their rows in the
  // list (`filterWritten` only drops excluded rows when the Excluded filter is set), so ticks left
  // behind would silently join the NEXT action's payload.
  const form = new FormState({
    onSuccess: () => {
      selectedReviews.clear();
      onSuccess();
    },
  });
  const modelUrl = (modelId: number | null) => (modelId ? `${civitaiUrl}/models/${modelId}` : null);
</script>

{#if form.error}
  <ErrorAlert class="mb-4" message={form.error} />
{/if}

<section class="mb-4 grid gap-4 lg:grid-cols-2">
  {#await account}
    <div class="rounded-xl border border-dark-4 bg-dark-6 p-5">
      <p class="text-sm text-dark-2">Loading reviews…</p>
    </div>
  {:then result}
    {#if result}
      {@const written = filterWritten(result.reviews.items)}
      <ListCard title="Reviews written" total={written.length} capped={result.reviews.truncated}>
        <!-- Retool's filter row. The bulk buttons below act on what is SELECTED, so filtering to the
             review in question is how a moderator avoids acting on the newest 25 by accident. -->
        {#snippet controls()}
          <ListFilterBar
            fields={WRITTEN_FILTERS}
            bind:values={writtenFilters}
            matched={written.length}
            total={result.reviews.items.length}
          />
        {/snippet}
        {#snippet children(limit)}
          {@const visible = written.slice(0, limit)}
          {@const visibleIds = visible.map((r) => r.id)}
          <!-- 🔴 Narrowed to what is RENDERED, not to `written`. `ListCard`'s limit shrinks as well as
               grows — its toggle reads "Show less" — and it is component-local `$state`, so the
               `{#await}` re-entering its pending branch on a reload collapses the card back to 5 rows.
               Narrowing by `written` therefore kept posting a row ticked at position 30 and then
               scrolled away, and Exclude/Include carry no confirmation to catch it. Nothing is lost by
               this: unlike `CommentList` there is no select-all here, so a row can only enter the
               selection by being rendered. -->
          {@const posting = postedIds(visible, selectedReviews)}
          <form method="POST" action="?/contentAction" use:enhance={form.enhance}>
            <input type="hidden" name="userId" value={userId} />
            <input type="hidden" name="kind" value="reviews" />
            <!-- One entry per id: `contentAction` reads them with `form.getAll('reviewIds')`, and a
                 joined string would act on a single row. Posted from the selection rather than from
                 the controls themselves so the payload and the confirmed count are one derivation. -->
            {#each posting as id (id)}
              <input type="hidden" name="reviewIds" value={id} />
            {/each}
            <ul class="space-y-1 text-sm">
              {#each visible as r (r.id)}
                <li
                  class="flex flex-wrap items-baseline gap-x-2"
                  data-touch-target={canAct ? '' : undefined}
                >
                  {#if canAct}
                    <SelectionCheckbox
                      selection={selectedReviews}
                      key={r.id}
                      order={visibleIds}
                      aria-label="Select review {r.id}"
                      class="mr-1"
                    />
                  {/if}
                  {#if modelUrl(r.modelId)}
                    <a href={modelUrl(r.modelId)} target="_blank" rel="noreferrer" class={LINK_CLASS}>
                      model {r.modelId}
                    </a>
                  {/if}
                  {#if r.rating !== null}<span class="text-dark-0">{r.rating}★</span>{/if}
                  {#if r.imageCount}
                    <span class="text-xs text-dark-2">{r.imageCount} img</span>
                  {/if}
                  {#if r.tosViolation}<Badge variant="destructive">ToS</Badge>{/if}
                  {#if r.nsfw}<Badge variant="secondary">NSFW</Badge>{/if}
                  {#if r.exclude}<Badge variant="secondary">excluded</Badge>{/if}
                  <span class="text-xs text-dark-2">{dateTime(r.createdAt)}</span>
                  {#if r.details}
                    <p class="w-full wrap-break-word text-dark-1">{plainText(r.details)}</p>
                  {/if}
                </li>
              {/each}
            </ul>
            {#if canAct}
              <!-- Exclude/Include have no confirmation step, so zero-selection is disabled rather
                   than posting an empty `reviewIds` the action would report success over. -->
              <div class="mt-3 flex flex-wrap gap-2 border-t border-dark-4 pt-3">
                <ConfirmSubmit
                  label="Delete"
                  name="op"
                  value="delete"
                  count={posting.length}
                  noun="review"
                  submitting={form.submitting}
                />
                <Button
                  type="submit"
                  name="op"
                  value="exclude"
                  size="sm"
                  variant="outline"
                  disabled={form.submitting || posting.length === 0}
                  data-touch-target
                >
                  Exclude
                </Button>
                <Button
                  type="submit"
                  name="op"
                  value="include"
                  size="sm"
                  variant="outline"
                  disabled={form.submitting || posting.length === 0}
                  data-touch-target
                >
                  Include
                </Button>
              </div>
            {/if}
          </form>
        {/snippet}
      </ListCard>

      {@const received = filterReceived(result.receivedReviews.items)}
      <ListCard
        title="Reviews received"
        total={received.length} capped={result.receivedReviews.truncated}
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
      <p class="text-sm text-red-300">Could not load reviews.</p>
    </div>
  {/await}
</section>
