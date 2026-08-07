<script lang="ts">
  import { enhance } from '$app/forms';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { LINK_CLASS, dateTime } from '$lib/format';
  import type { Account } from './user-account';
  import type { SubmitFunction } from '@sveltejs/kit';
  import type { FormResult } from './form-result';
  import ListCard from './ListCard.svelte';

  let {
    account,
    userId,
    canAct,
    form,
    civitaiUrl,
    onSubmit,
    submitting,
  }: {
    account: Promise<Account> | null;
    userId: number;
    canAct: boolean;
    form: FormResult;
    civitaiUrl: string;
    onSubmit: SubmitFunction;
    submitting: boolean;
  } = $props();

  const error = $derived(form?.scope === 'content' ? form.error : null);
  const modelUrl = (modelId: number | null) => (modelId ? `${civitaiUrl}/models/${modelId}` : null);
  const CHECKBOX = 'accent-blue-500 mr-1';
</script>

{#if error}
  <div
    class="mb-4 rounded-md border border-red-500/30 bg-red-500/10 p-2 text-sm text-red-300"
    role="alert"
  >
    {error}
  </div>
{/if}

<section class="mb-4 grid gap-4 lg:grid-cols-2">
  {#await account}
    <div class="rounded-xl border border-dark-4 bg-dark-6 p-5">
      <p class="text-sm text-dark-2">Loading reviews…</p>
    </div>
  {:then result}
    {#if result}
      <ListCard title="Reviews written" total={result.reviews.items.length} capped={result.reviews.truncated}>
        {#snippet children(limit)}
          <form method="POST" action="?/contentAction" use:enhance={onSubmit}>
            <input type="hidden" name="userId" value={userId} />
            <input type="hidden" name="kind" value="reviews" />
            <ul class="space-y-1 text-sm">
              {#each result.reviews.items.slice(0, limit) as r (r.id)}
                <li class="flex flex-wrap items-baseline gap-x-2">
                  {#if canAct}
                    <input type="checkbox" name="reviewIds" value={r.id} class={CHECKBOX} />
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
                  {#if r.exclude}<Badge variant="secondary">excluded</Badge>{/if}
                  <span class="text-xs text-dark-2">{dateTime(r.createdAt)}</span>
                </li>
              {/each}
            </ul>
            {#if canAct}
              <div class="mt-3 flex flex-wrap gap-2 border-t border-dark-4 pt-3">
                <Button type="submit" name="op" value="delete" size="sm" variant="destructive" disabled={submitting}>
                  Delete selected
                </Button>
                <Button type="submit" name="op" value="exclude" size="sm" variant="outline" disabled={submitting}>
                  Exclude
                </Button>
                <Button type="submit" name="op" value="include" size="sm" variant="outline" disabled={submitting}>
                  Include
                </Button>
              </div>
            {/if}
          </form>
        {/snippet}
      </ListCard>

      <ListCard
        title="Reviews received"
        total={result.receivedReviews.items.length} capped={result.receivedReviews.truncated}
        hint="On this user's models, by others. A burst of 1★ from few accounts is the signal."
      >
        {#snippet children(limit)}
          <ul class="space-y-1 text-sm">
            {#each result.receivedReviews.items.slice(0, limit) as r (r.id)}
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
