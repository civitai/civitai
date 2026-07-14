<script lang="ts">
  import { Card, CardHeader, CardTitle, CardContent } from '@civitai/ui/components/ui/card/index.js';
  import { Skeleton } from '@civitai/ui/components/ui/skeleton/index.js';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { IconArrowRight } from '@tabler/icons-svelte';
  import { currencyMeta, formatAmount } from '$lib/earnings';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
  const name = $derived(data.user.username ?? 'creator');
  const num = (n: number) => n.toLocaleString();

  // Real content activity (userId-keyed ClickHouse; no A1 needed).
  const activity = $derived(
    data.content
      ? [
          { label: 'Reactions', value: data.content.reactions },
          { label: 'New followers', value: data.content.followers },
          { label: 'Images posted', value: data.content.images },
          { label: 'Posts published', value: data.content.posts },
          { label: 'Profile views', value: data.content.profileViews },
        ]
      : []
  );

  // Earnings headline (A1 Part 1 — buzzTransactions, already owner-keyed). Buzz colors are summed for this glance
  // number (all buzz, same unit); cash is separate. The /earnings page keeps every currency distinct.
  const sumWhere = (pred: (currency: string) => boolean) =>
    (data.earnings ?? []).filter((b) => pred(b.currency)).reduce((s, b) => s + b.total, 0);
  const stats = $derived([
    {
      label: 'Buzz earned',
      value: data.earnings ? `⚡ ${num(sumWhere((c) => currencyMeta(c).family === 'buzz'))}` : null,
      hint: 'Yellow, blue & green — last 30 days',
    },
    {
      label: 'Cash ready',
      value: data.cash ? formatAmount(data.cash.settled, 'cashSettled') : null,
      hint: 'Available to withdraw',
    },
    {
      label: 'Cash pending',
      value: data.cash ? formatAmount(data.cash.pending, 'cashPending') : null,
      hint: 'Accruing to cash',
    },
    {
      label: 'Withdrawn',
      value: data.cash ? formatAmount(data.cash.withdrawn, 'cashSettled') : null,
      hint: 'Paid out to date',
    },
    { label: 'Top-earning model', value: null, pending: true, hint: 'Needs owner-keyed rollup (A1 Part 2)' },
  ]);

  const sections = [
    { href: '/models', title: 'Models', body: 'Set licensing fees, manage access, sell indefinitely.' },
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

{#if data.content}
  <section class="mb-8">
    <div class="mb-2 flex items-center justify-between">
      <p class="text-xs uppercase tracking-wide text-dark-3">Your activity — last 30 days</p>
      <a href="/analytics" class="text-xs text-dark-2 hover:text-white">View analytics →</a>
    </div>
    <div class="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
      {#each activity as a (a.label)}
        <Card>
          <CardContent>
            <p class="text-xs uppercase tracking-wide text-dark-3">{a.label}</p>
            <p class="mt-1 text-xl font-semibold text-white">{num(a.value)}</p>
          </CardContent>
        </Card>
      {/each}
    </div>
  </section>
{/if}

<section class="mb-8 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
  {#each stats as stat (stat.label)}
    <Card>
      <CardHeader>
        <CardTitle class="text-sm font-medium text-dark-2">{stat.label}</CardTitle>
      </CardHeader>
      <CardContent>
        {#if stat.value != null}
          <p class="text-xl font-semibold text-white">{stat.value}</p>
        {:else if stat.pending}
          <p class="text-xl font-semibold text-dark-4">—</p>
        {:else}
          <Skeleton class="h-7 w-24" />
        {/if}
        <p class="mt-2 text-xs text-dark-3">{stat.hint}</p>
      </CardContent>
    </Card>
  {/each}
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
