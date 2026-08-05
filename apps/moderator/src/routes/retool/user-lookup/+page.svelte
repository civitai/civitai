<script lang="ts">
  import { untrack } from 'svelte';
  import { goto } from '$app/navigation';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  // Local copy so typing doesn't navigate; re-synced whenever a search lands (incl. back/forward).
  let term = $state(untrack(() => data.q));
  $effect(() => {
    term = data.q;
  });

  const search = (e: SubmitEvent) => {
    e.preventDefault();
    const value = term.trim();
    goto(value ? `?q=${encodeURIComponent(value)}` : '?', { keepFocus: true });
  };

  const identity = $derived(data.result?.identity ?? null);
  const dateTime = (v: Date | string | null) =>
    v ? new Date(v).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—';
  const num = (n: number) => n.toLocaleString();

  const profileUrl = $derived(
    identity?.username ? `${data.civitaiUrl}/user/${encodeURIComponent(identity.username)}` : null
  );
  const contentUrl = (path: string) => (profileUrl ? `${profileUrl}/${path}` : null);
  const linkClass = 'text-blue-4 hover:underline';
</script>

<header class="page-header">
  <h1>User Lookup</h1>
  <p>Find a user by ID, username or email.</p>
</header>

<form onsubmit={search} class="mb-6 flex max-w-xl gap-2">
  <Input bind:value={term} placeholder="296765, username, or name@example.com" class="flex-1" />
  <Button type="submit">Search</Button>
</form>

{#if data.notFound}
  <section class="rounded-xl border border-dark-4 bg-dark-6 p-5">
    <p class="text-sm text-dark-2">No user matches <code>{data.q}</code>.</p>
  </section>
{:else if identity && data.result}
  <section class="mb-4 rounded-xl border border-dark-4 bg-dark-6 p-5">
    <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <h2 class="text-lg font-semibold text-white">
        {#if profileUrl}
          <a href={profileUrl} target="_blank" rel="noreferrer" class={linkClass}>
            {identity.username}
          </a>
        {:else}
          (no username)
        {/if}
      </h2>
      <code class="text-sm text-dark-2">#{identity.id}</code>
      {#if identity.bannedAt}
        <Badge variant="destructive">banned</Badge>
      {/if}
      {#if identity.muted}
        <Badge variant="destructive">muted</Badge>
      {/if}
      {#if identity.deletedAt}
        <Badge variant="secondary">deleted</Badge>
      {/if}
      {#if identity.isModerator}
        <Badge variant="secondary">moderator</Badge>
      {/if}
    </div>

    <dl class="mt-4 grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
      {#each [['Email', identity.email ?? '—'], ['Email verified', dateTime(identity.emailVerified)], ['Joined', dateTime(identity.createdAt)], ['Deleted', dateTime(identity.deletedAt)], ['Muted at', dateTime(identity.mutedAt)], ['Banned at', dateTime(identity.bannedAt)], ['Rewards eligibility', identity.rewardsEligibility ?? '—']] as [label, value] (label)}
        <div>
          <dt class="text-xs tracking-wide text-dark-3 uppercase">{label}</dt>
          <dd class="text-dark-0 break-all">{value}</dd>
        </div>
      {/each}

      <div>
        <dt class="text-xs tracking-wide text-dark-3 uppercase">Stripe customer</dt>
        <dd class="break-all">
          {#if identity.customerId}
            <a
              href="https://dashboard.stripe.com/customers/{identity.customerId}"
              target="_blank"
              rel="noreferrer"
              class={linkClass}>{identity.customerId}</a
            >
          {:else}
            <span class="text-dark-0">—</span>
          {/if}
        </dd>
      </div>
      <div>
        <dt class="text-xs tracking-wide text-dark-3 uppercase">Paddle customer</dt>
        <dd class="break-all">
          {#if identity.paddleCustomerId}
            <a
              href="https://vendors.paddle.com/customers-v2/{identity.paddleCustomerId}"
              target="_blank"
              rel="noreferrer"
              class={linkClass}>{identity.paddleCustomerId}</a
            >
          {:else}
            <span class="text-dark-0">—</span>
          {/if}
        </dd>
      </div>
    </dl>

    {#if identity.banReason || identity.banDetails}
      <div class="mt-4 rounded-md border border-red-500/30 bg-red-500/10 p-3 text-sm">
        <div class="font-medium text-red-300">Ban reason: {identity.banReason ?? '—'}</div>
        {#if identity.banDetails}
          <p class="mt-1 text-red-200/80">{identity.banDetails}</p>
        {/if}
      </div>
    {/if}
  </section>

  <section class="mb-4 rounded-xl border border-dark-4 bg-dark-6 p-5">
    <h3 class="mb-3 text-sm font-semibold text-white">Content</h3>
    <div class="grid gap-3 sm:grid-cols-3 lg:grid-cols-4">
      {#each data.result.counts as item (item.label)}
        {@const href = item.profilePath && item.count > 0 ? contentUrl(item.profilePath) : null}
        <div>
          <div class="text-xl font-semibold tabular-nums text-white">
            {#if href}
              <a {href} target="_blank" rel="noreferrer" class={linkClass}>{num(item.count)}</a>
            {:else}
              {num(item.count)}
            {/if}
          </div>
          <div class="text-xs text-dark-2">{item.label}</div>
        </div>
      {/each}
    </div>
  </section>

  {#if data.result.stats}
    <section class="rounded-xl border border-dark-4 bg-dark-6 p-5">
      <h3 class="mb-3 text-sm font-semibold text-white">Reputation</h3>
      <div class="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {#each [['Followers', num(data.result.stats.followers)], ['Following', num(data.result.stats.following)], ['Uploads', num(data.result.stats.uploads)], ['Downloads', num(data.result.stats.downloads)], ['Thumbs up', num(data.result.stats.thumbsUp)], ['Thumbs down', num(data.result.stats.thumbsDown)], ['Generations', num(data.result.stats.generations)]] as [label, value] (label)}
          <div>
            <div class="text-xl font-semibold tabular-nums text-white">{value}</div>
            <div class="text-xs text-dark-2">{label}</div>
          </div>
        {/each}
      </div>
    </section>
  {/if}
{/if}
