<script lang="ts">
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { LINK_CLASS, dateTime, num } from '$lib/format';
  import type { Account } from './user-account';
  import ListCard from './ListCard.svelte';

  let { account, civitaiUrl }: { account: Promise<Account> | null; civitaiUrl: string } = $props();

  const modelUrl = (modelId: number | null) => (modelId ? `${civitaiUrl}/models/${modelId}` : null);
  const bountyUrl = (bountyId: number) => `${civitaiUrl}/bounties/${bountyId}`;
  const CARD = 'rounded-xl border border-dark-4 bg-dark-6 p-5';
</script>

<section class="mb-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
  {#await account}
    <div class="{CARD} sm:col-span-2 xl:col-span-4">
      <p class="text-sm text-dark-2">Loading reviews, comments, cosmetics and reactions…</p>
    </div>
  {:then result}
    {#if result}
      <ListCard title="Reviews written" total={result.reviews.length}>
        {#snippet children(limit)}
          <ul class="space-y-1 text-sm">
            {#each result.reviews.slice(0, limit) as r (r.id)}
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
        {/snippet}
      </ListCard>

      <ListCard
        title="Reviews received"
        total={result.receivedReviews.length}
        hint="On this user's models, by others. A burst of 1★ from few accounts is the signal."
      >
        {#snippet children(limit)}
          <ul class="space-y-1 text-sm">
            {#each result.receivedReviews.slice(0, limit) as r (r.id)}
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

      <ListCard title="Comments" total={result.comments.length}>
        {#snippet children(limit)}
          <ul class="space-y-2 text-sm">
            {#each result.comments.slice(0, limit) as c (c.id)}
              <li>
                <div class="flex flex-wrap items-baseline gap-x-2">
                  {#if modelUrl(c.modelId)}
                    <a href={modelUrl(c.modelId)} target="_blank" rel="noreferrer" class={LINK_CLASS}>
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
        {/snippet}
      </ListCard>

      <ListCard title="Cosmetics" total={result.cosmetics.length}>
        {#snippet children(limit)}
          <ul class="space-y-1 text-sm">
            {#each result.cosmetics.slice(0, limit) as c (c.key)}
              <li class="flex flex-wrap items-baseline gap-x-2">
                <span class="text-dark-0">{c.name}</span>
                <Badge variant="secondary">{c.type}</Badge>
                {#if c.equipped}<span class="text-xs text-dark-2">equipped</span>{/if}
              </li>
            {/each}
          </ul>
        {/snippet}
      </ListCard>

      <ListCard
        title="Bounties funded"
        total={result.bounties.length}
        hint="Created by this user, with the total pledged across all benefactors."
      >
        {#snippet children(limit)}
          <ul class="space-y-1 text-sm">
            {#each result.bounties.slice(0, limit) as b (b.id)}
              <li class="flex flex-wrap items-baseline gap-x-2">
                <a href={bountyUrl(b.id)} target="_blank" rel="noreferrer" class="truncate {LINK_CLASS}">
                  {b.name}
                </a>
                <span class="tabular-nums text-dark-0">{num(b.unitAmount)} buzz</span>
                {#if b.complete}<Badge variant="secondary">complete</Badge>{/if}
                <span class="text-xs text-dark-2">{dateTime(b.createdAt)}</span>
              </li>
            {/each}
          </ul>
        {/snippet}
      </ListCard>

      <ListCard title="Bounty entries" total={result.bountyEntries.length}>
        {#snippet children(limit)}
          <ul class="space-y-1 text-sm">
            {#each result.bountyEntries.slice(0, limit) as e (e.id)}
              <li class="flex flex-wrap items-baseline gap-x-2">
                <a
                  href={bountyUrl(e.bountyId)}
                  target="_blank"
                  rel="noreferrer"
                  class="truncate {LINK_CLASS}"
                >
                  {e.bountyName}
                </a>
                <span class="text-xs text-dark-2">{dateTime(e.createdAt)}</span>
              </li>
            {/each}
          </ul>
        {/snippet}
      </ListCard>

      <ListCard
        title="Generations of their resources"
        total={result.resourceGenerations.length}
        hint="Last 30 days, most-used first. Concentration or a spike is the farming signal."
      >
        {#snippet children(limit)}
          <ul class="space-y-1 text-sm">
            {#each result.resourceGenerations.slice(0, limit) as g (g.modelVersionId)}
              <li class="flex flex-wrap items-baseline gap-x-2">
                <span class="tabular-nums text-dark-0">{num(g.count)}</span>
                <a
                  href="{civitaiUrl}/models/{g.modelId}?modelVersionId={g.modelVersionId}"
                  target="_blank"
                  rel="noreferrer"
                  class="truncate {LINK_CLASS}"
                >
                  {g.modelName}
                </a>
              </li>
            {/each}
          </ul>
        {/snippet}
      </ListCard>

      {#if result.notifications === null}
        <div class={CARD}>
          <h3 class="mb-3 text-sm font-semibold text-white">Notifications</h3>
          <p class="text-sm text-amber-300">Notifications service unavailable.</p>
        </div>
      {:else}
        <ListCard
          title="Notifications sent"
          total={result.notifications.length}
          hint="What the site has told this user — context for “I was never warned”."
        >
          {#snippet children(limit)}
            {#if result.notifications}
              <ul class="space-y-1 text-sm">
                {#each result.notifications.slice(0, limit) as n (n.id)}
                  <li class="flex flex-wrap items-baseline gap-x-2">
                    <span class="text-dark-0">{n.type}</span>
                    <Badge variant="secondary">{n.category}</Badge>
                    {#if !n.read}<span class="text-xs text-dark-2">unread</span>{/if}
                    <span class="text-xs text-dark-2">{dateTime(n.createdAt)}</span>
                  </li>
                {/each}
              </ul>
            {/if}
          {/snippet}
        </ListCard>
      {/if}

      <div class="{CARD} sm:col-span-2">
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
