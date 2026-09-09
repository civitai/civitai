<script lang="ts">
  import { untrack } from 'svelte';
  import { goto } from '$app/navigation';
  import { Tabs, TabsList, TabsTrigger } from '@civitai/ui/components/ui/tabs/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Checkbox } from '@civitai/ui/components/ui/checkbox/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import { Label } from '@civitai/ui/components/ui/label/index.js';
  import * as Select from '@civitai/ui/components/ui/select/index.js';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';
  import { num } from '$lib/format';
  import type { PageData } from './$types';
  import ActorTable from './ActorTable.svelte';
  import SharedIpPanel from './SharedIpPanel.svelte';
  import { CATEGORIES, LOOKBACKS } from './categories';

  let { data }: { data: PageData } = $props();

  // Not `LookupSearch`: that component REPLACES the whole query string, which Chat Audit depends on
  // and this page cannot use. The lookback, floor and tab are view settings, not properties of a
  // result set — dropping them on every new search silently answers a different question than the one
  // the moderator set up.
  let term = $state(untrack(() => data.q));
  $effect(() => {
    term = data.q;
  });

  const navigate = (patch: Record<string, string>) => {
    const params = new URLSearchParams({
      q: data.q,
      category: data.category,
      days: String(data.days),
      minCount: String(data.minCount),
      groupIpv4: data.groupIpv4 ? '1' : '0',
      ...patch,
    });
    goto(`?${params}`, { keepFocus: true });
  };

  const search = (e: SubmitEvent) => {
    e.preventDefault();
    navigate({ q: term.trim() });
  };

  const days = $derived(String(data.days));
  const meta = $derived(CATEGORIES.find((c) => c.value === data.category)!);
  const lookbackLabel = $derived(LOOKBACKS.find((l) => l.value === days)?.label ?? `${days} days`);
</script>

<header class="page-header">
  <h1>Reactor Lookup</h1>
  <p>
    Who is inflating an account. Enter a creator's user ID to see the accounts pushing engagement at
    them, ranked by how much of their own activity lands on this one target.
  </p>
</header>

<form onsubmit={search} class="mb-4 flex max-w-xl gap-2">
  <Input bind:value={term} placeholder="A creator's user ID, e.g. 2832460" class="flex-1" />
  <Button type="submit">Search</Button>
</form>

{#if data.sourcesDown.length}
  <ErrorAlert
    class="mb-4"
    message="Could not load: {data.sourcesDown.join(', ')}. The rest of the page is unaffected."
  />
{/if}

<div class="mb-4 flex flex-wrap items-end gap-4">
  <Tabs value={data.category} onValueChange={(v) => navigate({ category: v })}>
    <TabsList>
      {#each CATEGORIES as c (c.value)}
        <TabsTrigger value={c.value}>{c.label}</TabsTrigger>
      {/each}
    </TabsList>
  </Tabs>

  <div class="flex flex-col gap-1">
    <Label class="text-xs text-dark-2">Lookback</Label>
    <Select.Root type="single" value={days} onValueChange={(v) => navigate({ days: v })}>
      <Select.Trigger class="w-40">{lookbackLabel}</Select.Trigger>
      <Select.Content>
        {#each LOOKBACKS as l (l.value)}
          <Select.Item value={l.value} label={l.label}>{l.label}</Select.Item>
        {/each}
      </Select.Content>
    </Select.Root>
  </div>

  <div class="flex flex-col gap-1">
    <Label for="minCount" class="text-xs text-dark-2">Min {meta.countLabel.toLowerCase()}</Label>
    <Input
      id="minCount"
      type="number"
      min="1"
      value={data.minCount}
      class="w-24"
      onchange={(e) => navigate({ minCount: e.currentTarget.value || '1' })}
    />
  </div>

  <div class="flex items-center gap-2 pb-2">
    <Checkbox
      id="groupIpv4"
      checked={data.groupIpv4}
      onCheckedChange={(v) => navigate({ groupIpv4: v ? '1' : '0' })}
    />
    <Label for="groupIpv4" class="text-sm text-dark-2">Group IPv4 by /24</Label>
  </div>
</div>

{#if !data.q}
  <section class="rounded-xl border border-dark-4 bg-dark-6 p-5">
    <p class="text-sm text-dark-2">Enter a user ID above.</p>
  </section>
{:else if data.badId}
  <section class="rounded-xl border border-dark-4 bg-dark-6 p-5">
    <p class="text-sm text-dark-2">
      <code>{data.q}</code> is not a user ID. This page takes the numeric ID of the creator receiving
      the engagement.
    </p>
  </section>
{:else}
  <div class="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
    <section class="rounded-xl border border-dark-4 bg-dark-6 p-5">
      <div class="mb-1 flex flex-wrap items-baseline justify-between gap-2">
        <h2 class="text-sm font-semibold text-white">{meta.heading}</h2>
        <span class="text-xs text-dark-2">
          {#if data.total > data.actors.length}
            top {num(data.actors.length)} of {num(data.total)}
          {:else}
            {num(data.total)}
          {/if}
          over {num(data.minCount)}
        </span>
      </div>
      <p class="mb-3 text-xs text-dark-2">{meta.subtitle} Last {lookbackLabel.toLowerCase()}.</p>
      {#if data.capped}
        <p class="mb-3 text-xs text-yellow-300">
          This creator has more images than one pass walks, so only their most recent are counted.
          Treat the numbers as a floor.
        </p>
      {/if}
      <ActorTable
        actors={data.actors}
        {meta}
        sharesWithTarget={data.sharesWithTarget}
        sharesWithOther={data.sharesWithOther}
      />
    </section>

    <SharedIpPanel accounts={data.sharedIps} noisyThreshold={data.noisyThreshold} />
  </div>
{/if}
