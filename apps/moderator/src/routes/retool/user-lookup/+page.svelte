<script lang="ts">
  import { untrack } from 'svelte';
  import { goto } from '$app/navigation';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import type { PageData } from './$types';
  import type { FormResult } from './format';
  import AccountActionsPanel from './AccountActionsPanel.svelte';
  import ContentCounts from './ContentCounts.svelte';
  import IdentityPanel from './IdentityPanel.svelte';
  import ModActivityPanel from './ModActivityPanel.svelte';
  import ModerationMemoryPanel from './ModerationMemoryPanel.svelte';
  import ReportsPanel from './ReportsPanel.svelte';
  import ReputationPanel from './ReputationPanel.svelte';
  import SecuritySignals from './SecuritySignals.svelte';
  import SubscriptionPanel from './SubscriptionPanel.svelte';
  import UserContentPanel from './UserContentPanel.svelte';

  let { data, form }: { data: PageData; form: FormResult } = $props();

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
{:else if data.result}
  {@const result = data.result}
  <IdentityPanel identity={result.identity} civitaiUrl={data.civitaiUrl} />
  <ContentCounts
    counts={result.counts}
    civitaiUrl={data.civitaiUrl}
    username={result.identity.username}
  />
  <ReportsPanel reportsFiled={result.reportsFiled} reportedContent={result.reportedContent} />
  <!-- Inside the key block: a `?q=` navigation does not remount by default, so an open ban
       confirmation would otherwise survive and end up pointed at a different account. -->
  {#key result.identity.id}
    <AccountActionsPanel identity={result.identity} canAct={data.canAct} {form} />
    <ModerationMemoryPanel userId={result.identity.id} {form} />
    <SubscriptionPanel subscription={result.subscription} userId={result.identity.id} />
    <ModActivityPanel userId={result.identity.id} civitaiUrl={data.civitaiUrl} />
    <SecuritySignals userId={result.identity.id} />
    <UserContentPanel userId={result.identity.id} civitaiUrl={data.civitaiUrl} />
  {/key}
  {#if result.stats}
    <ReputationPanel stats={result.stats} />
  {/if}
{/if}
