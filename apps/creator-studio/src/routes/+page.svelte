<script lang="ts">
  import { Card, CardHeader, CardTitle, CardContent } from '@civitai/ui/components/ui/card/index.js';
  import { Skeleton } from '@civitai/ui/components/ui/skeleton/index.js';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
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

  // Earnings headline stats stay placeholders until the ClickHouse owner-keyed rollup lands (decision A1).
  const stats = [
    { label: 'Earned this period', hint: 'Awaiting analytics wiring' },
    { label: 'CP cash pending', hint: 'Awaiting analytics wiring' },
    { label: 'CP cash settled', hint: 'Awaiting analytics wiring' },
    { label: 'Top-earning model', hint: 'Needs owner-keyed rollup' },
  ];

  const sections = [
    { href: '/models', title: 'Models', body: 'Set licensing fees, manage access, sell indefinitely.' },
    { href: '/earnings', title: 'Earnings', body: 'Your earnings broken down by source.' },
    { href: '/earnings/analytics', title: 'Analytics', body: 'Usage that drives your fees.' },
    { href: '/licensing', title: 'Licensing', body: 'Bulk-edit fees across your versions.' },
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
      <a href="/earnings/analytics" class="text-xs text-dark-2 hover:text-white">View analytics →</a>
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

<section class="mb-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
  {#each stats as stat (stat.label)}
    <Card>
      <CardHeader>
        <CardTitle class="text-sm font-medium text-dark-2">{stat.label}</CardTitle>
      </CardHeader>
      <CardContent>
        <Skeleton class="h-7 w-24" />
        <p class="mt-2 text-xs text-dark-3">{stat.hint}</p>
      </CardContent>
    </Card>
  {/each}
</section>

<section class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
  {#each sections as section (section.href)}
    <a href={section.href} class="block">
      <Card class="h-full transition-colors hover:border-dark-3">
        <CardHeader>
          <CardTitle class="text-base text-white">{section.title}</CardTitle>
        </CardHeader>
        <CardContent>
          <p class="text-sm text-dark-2">{section.body}</p>
        </CardContent>
      </Card>
    </a>
  {/each}
</section>
