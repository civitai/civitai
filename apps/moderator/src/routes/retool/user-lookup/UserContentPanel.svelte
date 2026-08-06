<script lang="ts">
  import { browser } from '$app/environment';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { LINK_CLASS, dateTime } from './format';

  type Review = {
    id: number;
    createdAt: string;
    rating: number | null;
    modelId: number | null;
    tosViolation: boolean | null;
    exclude: boolean | null;
    modelCreator: string | null;
  };
  type Comment = {
    id: number;
    createdAt: string;
    content: string;
    nsfw: boolean | null;
    tosViolation: boolean | null;
    modelId: number | null;
  };
  type Cosmetic = {
    id: number;
    name: string;
    type: string;
    equipped: boolean;
    obtainedAt: string | null;
  };
  type Account = { reviews: Review[]; comments: Comment[]; cosmetics: Cosmetic[] };

  let { userId, civitaiUrl }: { userId: number; civitaiUrl: string } = $props();

  const SHOWN = 5;
  let showReviews = $state(false);
  let showComments = $state(false);
  let showCosmetics = $state(false);

  const account = $derived(
    browser
      ? fetch(`/api/user-account/${userId}`).then((r): Promise<Account> => {
          if (!r.ok) throw new Error(String(r.status));
          return r.json();
        })
      : null
  );

  const modelUrl = (modelId: number | null) => (modelId ? `${civitaiUrl}/models/${modelId}` : null);
  const CARD = 'rounded-xl border border-dark-4 bg-dark-6 p-5';
</script>

<section class="mb-4 grid gap-4 lg:grid-cols-3">
  {#await account}
    <div class="{CARD} lg:col-span-3">
      <p class="text-sm text-dark-2">Loading reviews, comments and cosmetics…</p>
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
          {#if result.reviews.length > SHOWN}
            <button
              type="button"
              class="mt-3 text-sm {LINK_CLASS}"
              onclick={() => (showReviews = !showReviews)}
            >
              {showReviews ? 'Show less' : `Show all ${result.reviews.length}`}
            </button>
          {/if}
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
          {#if result.comments.length > SHOWN}
            <button
              type="button"
              class="mt-3 text-sm {LINK_CLASS}"
              onclick={() => (showComments = !showComments)}
            >
              {showComments ? 'Show less' : `Show all ${result.comments.length}`}
            </button>
          {/if}
        {/if}
      </div>

      <div class={CARD}>
        <h3 class="mb-3 text-sm font-semibold text-white">Cosmetics ({result.cosmetics.length})</h3>
        {#if result.cosmetics.length === 0}
          <p class="text-sm text-dark-2">None.</p>
        {:else}
          <ul class="space-y-1 text-sm">
            {#each showCosmetics ? result.cosmetics : result.cosmetics.slice(0, SHOWN) as c (c.id)}
              <li class="flex flex-wrap items-baseline gap-x-2">
                <span class="text-dark-0">{c.name}</span>
                <Badge variant="secondary">{c.type}</Badge>
                {#if c.equipped}<span class="text-xs text-dark-2">equipped</span>{/if}
              </li>
            {/each}
          </ul>
          {#if result.cosmetics.length > SHOWN}
            <button
              type="button"
              class="mt-3 text-sm {LINK_CLASS}"
              onclick={() => (showCosmetics = !showCosmetics)}
            >
              {showCosmetics ? 'Show less' : `Show all ${result.cosmetics.length}`}
            </button>
          {/if}
        {/if}
      </div>
    {/if}
  {:catch}
    <div class="{CARD} lg:col-span-3">
      <p class="text-sm text-red-300">Could not load reviews, comments or cosmetics.</p>
    </div>
  {/await}
</section>
