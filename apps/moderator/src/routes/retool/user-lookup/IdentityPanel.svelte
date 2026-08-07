<script lang="ts">
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import type { PageData } from './$types';
  import { userUrl } from '$lib/entity-url';
  import { LINK_CLASS, dateTime } from '$lib/format';

  type Identity = NonNullable<PageData['result']>['identity'];
  type Profile = NonNullable<PageData['result']>['profile'];
  type Curator = NonNullable<PageData['result']>['curator'];

  let {
    identity,
    profile,
    curator,
    civitaiUrl,
  }: { identity: Identity; profile: Profile; curator: Curator; civitaiUrl: string } = $props();

  const profileText = $derived(
    [
      ['Bio', profile?.bio],
      ['Profile message', profile?.message],
      ['Location', profile?.location],
    ].filter((entry): entry is [string, string] => !!entry[1]?.trim())
  );

  const profileUrl = $derived(
    identity.username ? userUrl(civitaiUrl, identity.username) : null
  );

  const fields = $derived<[string, string][]>([
    ['Email', identity.email ?? '—'],
    ['Email verified', dateTime(identity.emailVerified)],
    ['Joined', dateTime(identity.createdAt)],
    ['Deleted', dateTime(identity.deletedAt)],
    ['Muted at', dateTime(identity.mutedAt)],
    ['Banned at', dateTime(identity.bannedAt)],
    ['Rewards eligibility', identity.rewardsEligibility ?? '—'],
  ]);
</script>

<section class="mb-4 rounded-xl border border-dark-4 bg-dark-6 p-5">
  <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
    <h2 class="text-lg font-semibold text-white">
      {#if profileUrl}
        <a href={profileUrl} target="_blank" rel="noreferrer" class={LINK_CLASS}>
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
    {#if curator.isCurator}
      <Badge variant="secondary">
        curator ({curator.collectionIds.join(', ')})
      </Badge>
    {/if}
  </div>

  <dl class="mt-4 grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
    {#each fields as [label, value] (label)}
      <div>
        <dt class="text-xs tracking-wide text-dark-2 uppercase">{label}</dt>
        <dd class="text-dark-0 break-all">{value}</dd>
      </div>
    {/each}

    <div>
      <dt class="text-xs tracking-wide text-dark-2 uppercase">Stripe customer</dt>
      <dd class="break-all">
        {#if identity.customerId}
          <a
            href="https://dashboard.stripe.com/customers/{identity.customerId}"
            target="_blank"
            rel="noreferrer"
            class={LINK_CLASS}>{identity.customerId}</a
          >
        {:else}
          <span class="text-dark-0">—</span>
        {/if}
      </dd>
    </div>
    <div>
      <dt class="text-xs tracking-wide text-dark-2 uppercase">Paddle customer</dt>
      <dd class="break-all">
        {#if identity.paddleCustomerId}
          <a
            href="https://vendors.paddle.com/customers-v2/{identity.paddleCustomerId}"
            target="_blank"
            rel="noreferrer"
            class={LINK_CLASS}>{identity.paddleCustomerId}</a
          >
        {:else}
          <span class="text-dark-0">—</span>
        {/if}
      </dd>
    </div>
  </dl>

  {#if profileText.length}
    <dl class="mt-4 grid gap-x-8 gap-y-2 border-t border-dark-4 pt-4 text-sm sm:grid-cols-3">
      {#each profileText as [label, value] (label)}
        <div>
          <dt class="text-xs tracking-wide text-dark-2 uppercase">{label}</dt>
          <dd class="whitespace-pre-wrap text-dark-0">{value}</dd>
        </div>
      {/each}
    </dl>
  {/if}

  {#if identity.banReason || identity.banDetails}
    <div class="mt-4 rounded-md border border-red-500/30 bg-red-500/10 p-3 text-sm">
      <div class="font-medium text-red-300">Ban reason: {identity.banReason ?? '—'}</div>
      {#if identity.banDetails}
        <p class="mt-1 text-red-200/80">{identity.banDetails}</p>
      {/if}
    </div>
  {/if}
</section>
