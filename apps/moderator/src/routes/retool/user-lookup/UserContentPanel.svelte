<script lang="ts">
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { LINK_CLASS, dateTime, num } from './format';
  import type { Account } from './user-account';

  let { account, civitaiUrl }: { account: Promise<Account> | null; civitaiUrl: string } = $props();

  const SHOWN = 5;
  let showReviews = $state(false);
  let showComments = $state(false);
  let showCosmetics = $state(false);

  const modelUrl = (modelId: number | null) => (modelId ? `${civitaiUrl}/models/${modelId}` : null);
  const CARD = 'rounded-xl border border-dark-4 bg-dark-6 p-5';
</script>

{#snippet moreToggle(total: number, expanded: boolean, toggle: () => void)}
  {#if total > SHOWN}
    <button type="button" class="mt-3 text-sm {LINK_CLASS}" onclick={toggle}>
      {expanded ? 'Show less' : `Show all ${total}`}
    </button>
  {/if}
{/snippet}

<section class="mb-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
  {#await account}
    <div class="{CARD} sm:col-span-2 xl:col-span-4">
      <p class="text-sm text-dark-2">Loading reviews, comments, cosmetics and reactions…</p>
    </div>
  {:then result}
    {#if result}
      <div class={CARD}>
        <h3 class="mb-3 text-sm font-semibold text-white">Reviews ({result.reviews.length})</h3>
        {#if result.reviews.length === 0}
          <p class="text-sm text-dark-2">None.</p>
        {:else}
          <ul class="space-y-1 text-sm">
            {#each showReviews ? result.reviews : result.reviews.slice(0, SHOWN) as r (r.id)}
              <li class="flex flex-wrap items-baseline gap-x-2">
                {#if modelUrl(r.modelId)}
                  <a href={modelUrl(r.modelId)} target="_blank" rel="noreferrer" class={LINK_CLASS}>
                    model {r.modelId}
                  </a>
                {/if}
                {#if r.rating !== null}<span class="text-dark-0">{r.rating}★</span>{/if}
                {#if r.tosViolation}<Badge variant="destructive">ToS</Badge>{/if}
                {#if r.exclude}<Badge variant="secondary">excluded</Badge>{/if}
                <span class="text-xs text-dark-2">{dateTime(r.createdAt)}</span>
              </li>
            {/each}
          </ul>
          {@render moreToggle(
            result.reviews.length,
            showReviews,
            () => (showReviews = !showReviews)
          )}
        {/if}
      </div>

      <div class={CARD}>
        <h3 class="mb-3 text-sm font-semibold text-white">Comments ({result.comments.length})</h3>
        {#if result.comments.length === 0}
          <p class="text-sm text-dark-2">None.</p>
        {:else}
          <ul class="space-y-2 text-sm">
            {#each showComments ? result.comments : result.comments.slice(0, SHOWN) as c (c.id)}
              <li>
                <div class="flex flex-wrap items-baseline gap-x-2">
                  {#if modelUrl(c.modelId)}
                    <a
                      href={modelUrl(c.modelId)}
                      target="_blank"
                      rel="noreferrer"
                      class={LINK_CLASS}
                    >
                      model {c.modelId}
                    </a>
                  {/if}
                  {#if c.tosViolation}<Badge variant="destructive">ToS</Badge>{/if}
                  {#if c.nsfw}<Badge variant="secondary">nsfw</Badge>{/if}
                  <span class="text-xs text-dark-2">{dateTime(c.createdAt)}</span>
                </div>
                <p class="line-clamp-2 text-dark-1">{c.content}</p>
              </li>
            {/each}
          </ul>
          {@render moreToggle(
            result.comments.length,
            showComments,
            () => (showComments = !showComments)
          )}
        {/if}
      </div>

      <div class={CARD}>
        <h3 class="mb-3 text-sm font-semibold text-white">Cosmetics ({result.cosmetics.length})</h3>
        {#if result.cosmetics.length === 0}
          <p class="text-sm text-dark-2">None.</p>
        {:else}
          <ul class="space-y-1 text-sm">
            {#each showCosmetics ? result.cosmetics : result.cosmetics.slice(0, SHOWN) as c (c.key)}
              <li class="flex flex-wrap items-baseline gap-x-2">
                <span class="text-dark-0">{c.name}</span>
                <Badge variant="secondary">{c.type}</Badge>
                {#if c.equipped}<span class="text-xs text-dark-2">equipped</span>{/if}
              </li>
            {/each}
          </ul>
          {@render moreToggle(
            result.cosmetics.length,
            showCosmetics,
            () => (showCosmetics = !showCosmetics)
          )}
        {/if}
      </div>

      <div class={CARD}>
        <h3 class="mb-1 text-sm font-semibold text-white">
          Image reactions given ({num(result.reactions.total)})
        </h3>
        <p class="mb-3 text-xs text-dark-2">
          Creators reacted to most, across {num(result.reactions.creators)}
          {result.reactions.creators === 1 ? 'creator' : 'creators'}. Concentration on one is the
          signal. Images only — article and comment reactions are not counted.
        </p>
        {#if result.reactions.targets.length === 0}
          <p class="text-sm text-dark-2">None.</p>
        {:else}
          <ul class="space-y-1 text-sm">
            {#each result.reactions.targets as t (t.userId)}
              <li class="flex flex-wrap items-baseline gap-x-2">
                <span class="tabular-nums text-dark-0">{num(t.count)}</span>
                <a href="?q={t.userId}" class={LINK_CLASS}>{t.username ?? `#${t.userId}`}</a>
              </li>
            {/each}
          </ul>
          {#if result.reactions.creators > result.reactions.targets.length}
            <p class="mt-2 text-xs text-dark-2">
              Top {result.reactions.targets.length} of {num(result.reactions.creators)}.
            </p>
          {/if}
        {/if}
      </div>
    {/if}
  {:catch}
    <div class="{CARD} sm:col-span-2 xl:col-span-4">
      <p class="text-sm text-red-300">Could not load reviews, comments, cosmetics or reactions.</p>
    </div>
  {/await}
</section>
