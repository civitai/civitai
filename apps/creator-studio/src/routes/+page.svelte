<script lang="ts">
  import { Card, CardHeader, CardTitle, CardContent } from '@civitai/ui/components/ui/card/index.js';
  import { Skeleton } from '@civitai/ui/components/ui/skeleton/index.js';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import {
    IconArrowRight,
    IconHeart,
    IconUserPlus,
    IconPhoto,
    IconArticle,
    IconEye,
    IconBolt,
    IconCash,
    IconClock,
    IconBuildingBank,
    IconTrophy,
  } from '@tabler/icons-svelte';
  import { currencyMeta, formatAmount, formatBuzz } from '$lib/earnings';
  import DeltaChip from '$lib/components/DeltaChip.svelte';
  import BuzzAmount from '$lib/components/BuzzAmount.svelte';
  import StatCard from '$lib/components/StatCard.svelte';
  import type { PageData } from './$types';

  type Stat = {
    label: string;
    value: string | null;
    pending: boolean;
    hint: string;
    icon: typeof IconBolt;
    color: string;
    // When present, the value is a buzz amount rendered via <BuzzAmount>; otherwise `value` is shown verbatim.
    buzz?: number;
  };

  let { data }: { data: PageData } = $props();
  const name = $derived(data.user.username ?? 'creator');
  const num = (n: number) => n.toLocaleString();

  // Real content activity (userId-keyed ClickHouse; no A1 needed).
  const activity = $derived(
    data.content
      ? [
          { label: 'Reactions', value: data.content.reactions, prev: data.contentPrev?.reactions ?? null, icon: IconHeart, color: '#ff6b6b' },
          { label: 'New followers', value: data.content.followers, prev: data.contentPrev?.followers ?? null, icon: IconUserPlus, color: '#4dabf7' },
          { label: 'Images posted', value: data.content.images, prev: data.contentPrev?.images ?? null, icon: IconPhoto, color: '#9775fa' },
          { label: 'Posts published', value: data.content.posts, prev: data.contentPrev?.posts ?? null, icon: IconArticle, color: '#3bc9db' },
          { label: 'Profile views', value: data.content.profileViews, prev: data.contentPrev?.profileViews ?? null, icon: IconEye, color: '#20c997' },
        ]
      : []
  );

  // Earnings headline (A1 Part 1 — buzzTransactions, already owner-keyed). Buzz colors are summed for this glance
  // number (all buzz, same unit); cash is separate. The /earnings page keeps every currency distinct.
  const sumWhere = (pred: (currency: string) => boolean) =>
    (data.earnings ?? []).filter((b) => pred(b.currency)).reduce((s, b) => s + b.total, 0);
  // Buzz earned this period vs the previous one, for the "Buzz earned" delta chip.
  const buzzNow = $derived(sumWhere((c) => currencyMeta(c).family === 'buzz'));
  const buzzPrev = $derived(
    data.earningsPrev
      ? data.earningsPrev
          .filter((b) => currencyMeta(b.currency).family === 'buzz')
          .reduce((s, b) => s + b.total, 0)
      : null
  );
  // Cash is Creator-Program-only; hide those cards for non-members (they'd be a meaningless $0 — or a stuck
  // skeleton if the buzz service has no cash account for them).
  const cashStats: Stat[] = $derived(
    data.membership.isCreatorProgramMember
      ? [
          {
            label: 'Cash pending',
            value: data.cash ? formatAmount(data.cash.pending, 'cashPending') : null,
            pending: false,
            hint: 'Pending settlement',
            icon: IconClock,
            color: '#63e6be',
          },
          {
            label: 'Cash settled',
            value: data.cash ? formatAmount(data.cash.settled, 'cashSettled') : null,
            pending: false,
            hint: 'Available to withdraw',
            icon: IconCash,
            color: '#12b886',
          },
          {
            label: 'Withdrawn',
            value: data.cash ? formatAmount(data.cash.withdrawn, 'cashSettled') : null,
            pending: false,
            hint: 'Paid out to date',
            icon: IconBuildingBank,
            color: '#868e96',
          },
        ]
      : []
  );
  const topModel = $derived(data.topModels?.[0] ?? null);
  // The model name is the subtext under the top-earning card's buzz value.
  const topModelName = $derived(
    topModel
      ? (topModel.modelName ?? topModel.versionName ?? `Version ${topModel.modelVersionId}`)
      : null
  );
  // The buzz currencies summed into "Buzz earned" — shown as coloured dots so the legend fits one line.
  const buzzLegend = ['#ffd43b', '#4dabf7', '#40c057'];
  const stats: Stat[] = $derived([
    {
      label: 'Buzz earned',
      value: data.earnings ? formatBuzz(buzzNow) : null,
      buzz: buzzNow,
      pending: false,
      hint: 'Last 30 days',
      icon: IconBolt,
      color: '#f59f00',
    },
    ...cashStats,
    {
      label: 'Top-earning model',
      // Buzz earned is the headline; the model name is the subtext (see topModelName).
      value: topModel ? formatBuzz(topModel.buzzTotal) : null,
      buzz: topModel?.buzzTotal,
      // Loaded-but-empty shows the em dash; a failed load (null) falls through to the skeleton.
      pending: data.topModels != null && !topModel,
      hint: topModel ? 'Last 30 days' : 'No model earnings yet',
      icon: IconTrophy,
      color: '#ff922b',
    },
  ]);

  const sections = [
    { href: '/models', title: 'Licensing', body: 'Set licensing fees, manage access, sell indefinitely.' },
    { href: '/earnings', title: 'Earnings', body: 'Your earnings broken down by source.' },
    { href: '/analytics', title: 'Analytics', body: 'Usage that drives your fees.' },
    { href: '/settings', title: 'Settings', body: 'Payout status, membership, defaults.' },
  ];
</script>

<header class="page-header flex items-center gap-3">
  <div>
    <h1>Creator Studio</h1>
    <p>Welcome back, {name}.</p>
  </div>
  {#if data.membership.isMember}
    <Badge variant="secondary" class="ml-auto capitalize">{data.membership.tier} member</Badge>
  {:else}
    <a href="/join" class="ml-auto"><Badge variant="outline">Become a member</Badge></a>
  {/if}
</header>

<section class="mb-8">
  <div class="mb-2 flex items-center justify-between">
    <p class="text-xs uppercase tracking-wide text-dark-2">Your activity — last 30 days</p>
    <a href="/analytics" class="text-xs text-dark-2 hover:text-white">View analytics →</a>
  </div>
  {#if data.content}
    <div class="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
      {#each activity as a (a.label)}
        <StatCard label={a.label} icon={a.icon} color={a.color}>
          <div class="mt-1 flex items-baseline gap-2">
            <p class="text-xl font-semibold text-white">{num(a.value)}</p>
            <DeltaChip current={a.value} previous={a.prev} />
          </div>
        </StatCard>
      {/each}
    </div>
  {:else}
    <p class="text-sm text-dark-3">Activity is temporarily unavailable — please try again shortly.</p>
  {/if}
</section>

<section class="mb-8">
  <div class="mb-2 flex items-center justify-between">
    <p class="text-xs uppercase tracking-wide text-dark-2">Earnings</p>
    <a href="/earnings" class="text-xs text-dark-2 hover:text-white">View earnings →</a>
  </div>
  <div class="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
    {#each stats as stat (stat.label)}
      <StatCard label={stat.label} icon={stat.icon} color={stat.color}>
        {#if stat.value != null}
          <div class="mt-1 flex items-baseline gap-2">
            <p class="text-xl font-semibold text-white">
              {#if stat.buzz != null}<BuzzAmount amount={stat.buzz} />{:else}{stat.value}{/if}
            </p>
            {#if stat.label === 'Buzz earned'}<DeltaChip current={buzzNow} previous={buzzPrev} />{/if}
          </div>
        {:else if stat.pending}
          <p class="mt-1 text-xl font-semibold text-dark-4">—</p>
        {:else}
          <Skeleton class="mt-1 h-7 w-24" />
        {/if}
        {#if stat.label === 'Top-earning model' && topModelName}
          <!-- Model name + compact scope on one line, so this card stays the same height as the others. -->
          <p class="mt-2 flex items-baseline gap-1 text-xs">
            <span class="truncate text-dark-2" title={topModelName}>{topModelName}</span>
            <span class="shrink-0 text-dark-4">· 30d</span>
          </p>
        {:else}
          <p class="mt-2 flex items-center gap-1 text-xs text-dark-3">
            {#if stat.label === 'Buzz earned'}
              {#each buzzLegend as c (c)}
                <span class="inline-block h-2 w-2 rounded-full" style="background:{c}"></span>
              {/each}
            {/if}
            <span>{stat.hint}</span>
          </p>
        {/if}
      </StatCard>
    {/each}
  </div>
</section>

<section class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
  {#each sections as section (section.href)}
    <a href={section.href} class="group block">
      <Card class="h-full cursor-pointer transition-colors hover:border-blue-8/60 hover:bg-dark-6">
        <CardHeader class="flex flex-row items-center gap-2">
          <CardTitle class="text-base text-white">{section.title}</CardTitle>
          <IconArrowRight
            size={16}
            class="ml-auto text-dark-3 transition-transform group-hover:translate-x-0.5 group-hover:text-white"
          />
        </CardHeader>
        <CardContent>
          <p class="text-sm text-dark-2">{section.body}</p>
        </CardContent>
      </Card>
    </a>
  {/each}
</section>
