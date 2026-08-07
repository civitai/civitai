<script lang="ts">
  import { untrack } from 'svelte';
  import { browser } from '$app/environment';
  import { goto } from '$app/navigation';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import type { PageData } from './$types';
  import type { FormResult } from './form-result';
  import { fetchAccount } from './user-account';
  import AccountActionsPanel from './AccountActionsPanel.svelte';
  import BuzzHistoryPanel from './BuzzHistoryPanel.svelte';
  import ContentCounts from './ContentCounts.svelte';
  import IdentityPanel from './IdentityPanel.svelte';
  import ModActivityPanel from './ModActivityPanel.svelte';
  import ModerationMemoryPanel from './ModerationMemoryPanel.svelte';
  import ReportsPanel from './ReportsPanel.svelte';
  import ReputationPanel from './ReputationPanel.svelte';
  import SecuritySignals from './SecuritySignals.svelte';
  import SubscriptionPanel from './SubscriptionPanel.svelte';
  import TrainingsPanel from './TrainingsPanel.svelte';
  import UserContentPanel from './UserContentPanel.svelte';

  let { data, form }: { data: PageData; form: FormResult } = $props();

  // Local copy so typing doesn't navigate; re-synced whenever a search lands (incl. back/forward).
  let term = $state(untrack(() => data.q));
  $effect(() => {
    term = data.q;
  });

  // One fetch for the whole page: Subscription wants the Buzz balance and UserContent wants the lists,
  // and each fetching for itself ran the endpoint — including the 744M-row reaction scan — twice.
  const account = $derived(
    browser && data.result ? fetchAccount(data.result.identity.id) : null
  );

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
  <IdentityPanel
    identity={result.identity}
    profile={result.profile}
    curator={result.curator}
    canAct={data.canAct}
    {form}
    civitaiUrl={data.civitaiUrl}
  />
  <ContentCounts
    counts={result.counts}
    civitaiUrl={data.civitaiUrl}
    username={result.identity.username}
  />
  <ReputationPanel stats={result.stats} scores={result.scores} ranks={result.ranks} />

  <!-- Order is deliberate, and reads top-down as an investigation: who they are, what they did, what we
       already know about them, and only then what to do about it. Account actions sits LAST because a
       moderator reads down the page — with it near the top, the ban button came before the blocked
       prompts, shared-IP accounts, strikes and mod history that justify pressing it.

       Inside the key block: a `?q=` navigation does not remount by default, so an open ban confirmation
       would otherwise survive and end up pointed at a different account. -->
  {#key result.identity.id}
    <!-- what they did -->
    <UserContentPanel {account} civitaiUrl={data.civitaiUrl} />
    <TrainingsPanel {account} civitaiUrl={data.civitaiUrl} />
    <SubscriptionPanel subscription={result.subscription} {account} />
    <BuzzHistoryPanel userId={result.identity.id} />

    <!-- what we already know -->
    <ReportsPanel reportsFiled={result.reportsFiled} reportedContent={result.reportedContent} />
    <SecuritySignals userId={result.identity.id} canAct={data.canAct} {form} />
    <ModActivityPanel userId={result.identity.id} civitaiUrl={data.civitaiUrl} />
    <ModerationMemoryPanel userId={result.identity.id} canAct={data.canAct} {form} />

    <!-- what to do -->
    <AccountActionsPanel identity={result.identity} canAct={data.canAct} {form} />
  {/key}
{/if}
