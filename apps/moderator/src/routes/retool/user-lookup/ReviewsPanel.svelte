<script lang="ts">
  import { FormState } from '$lib/form-state.svelte';
  import { enhance } from '$app/forms';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { LINK_CLASS, dateTime, plainText } from '$lib/format';
  import type { Account } from './user-account';
      import ListCard from './ListCard.svelte';
  import ListFilterBar, { type FilterField } from '$lib/components/ListFilterBar.svelte';
  import ConfirmSubmit from '$lib/components/ConfirmSubmit.svelte';

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

  // Bound so the confirmation can name a count. The inputs stay in the form, so they still post.
  let selectedReviews = $state<number[]>([]);
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
  const form = new FormState({ onSuccess: () => onSuccess() });
  const modelUrl = (modelId: number | null) => (modelId ? `${civitaiUrl}/models/${modelId}` : null);
  const CHECKBOX = 'accent-blue-500 mr-1';
</script>

{#if form.error}
  <div
    class="mb-4 rounded-md border border-red-500/30 bg-red-500/10 p-2 text-sm text-red-300"
    role="alert"
  >
    {form.error}
  </div>
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
          <form method="POST" action="?/contentAction" use:enhance={form.enhance}>
            <input type="hidden" name="userId" value={userId} />
            <input type="hidden" name="kind" value="reviews" />
            <ul class="space-y-1 text-sm">
              {#each written.slice(0, limit) as r (r.id)}
                <li class="flex flex-wrap items-baseline gap-x-2">
                  {#if canAct}
                    <input
                      type="checkbox"
                      name="reviewIds"
                      value={r.id}
                      bind:group={selectedReviews}
                      class={CHECKBOX}
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
              <div class="mt-3 flex flex-wrap gap-2 border-t border-dark-4 pt-3">
                <ConfirmSubmit
                  label="Delete"
                  name="op"
                  value="delete"
                  count={selectedReviews.length}
                  noun="review"
                  submitting={form.submitting}
                />
                <Button type="submit" name="op" value="exclude" size="sm" variant="outline" disabled={form.submitting}>
                  Exclude
                </Button>
                <Button type="submit" name="op" value="include" size="sm" variant="outline" disabled={form.submitting}>
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
