<script lang="ts">
  import { browser } from '$app/environment';
  import type { PageData } from './$types';
  import type { FormResult } from '../form-result';
  import { writeEnhancer } from '$lib/form-action';
  import { fetchAccount } from '../user-account';
  import { fetchSignals } from '../signals';
  import AccountActionsPanel from '../AccountActionsPanel.svelte';
  import AddressesPanel from '../AddressesPanel.svelte';
  import BountiesPanel from '../BountiesPanel.svelte';
  import BuzzHistoryPanel from '../BuzzHistoryPanel.svelte';
  import ChatContactPanel from '../ChatContactPanel.svelte';
  import CommentsPanel from '../CommentsPanel.svelte';
  import ContentCounts from '../ContentCounts.svelte';
  import CosmeticsPanel from '../CosmeticsPanel.svelte';
  import GenerationPanel from '../GenerationPanel.svelte';
  import IdentityPanel from '../IdentityPanel.svelte';
  import ModActivityPanel from '../ModActivityPanel.svelte';
  import ModerationMemoryPanel from '../ModerationMemoryPanel.svelte';
  import NotificationsPanel from '../NotificationsPanel.svelte';
  import PromptAuditPanel from '../PromptAuditPanel.svelte';
  import ReactionsPanel from '../ReactionsPanel.svelte';
  import ReportsPanel from '../ReportsPanel.svelte';
  import ReputationPanel from '../ReputationPanel.svelte';
  import ReviewsPanel from '../ReviewsPanel.svelte';
  import ShopPanel from '../ShopPanel.svelte';
  import SocialsPanel from '../SocialsPanel.svelte';
  import SubscriptionPanel from '../SubscriptionPanel.svelte';
  import TrainingsPanel from '../TrainingsPanel.svelte';

  let { data, form }: { data: PageData; form: FormResult } = $props();

  const result = $derived(data.result);
  const section = $derived(data.section);

  // Bumped after a write so the derived fetches rebuild. The panels' data comes from `/api/*`, not
  // from `load`, so invalidating the page would not bring it back.
  let version = $state(0);
  let submitting = $state(false);

  // One fetch per endpoint per section, shared by whichever panels the section renders. Fetching per
  // panel ran the account endpoint — including the 744M-row reaction scan — once per panel.
  const account = $derived(browser && result ? fetchAccount(result.identity.id) : null);
  const signals = $derived(browser && result ? fetchSignals(result.identity.id, version) : null);

  // Panels reset their own local state through `onWritten`; the page owns only the refresh, because it
  // owns the promises. See form-action.ts for why this does not invalidate.
  const onSubmit = writeEnhancer({
    onSuccess: () => (version += 1),
    busy: (value) => (submitting = value),
  });
</script>

{#if result}
  <!-- A `?q=` navigation does not remount by default, so without the key an open ban confirmation
       would survive and end up pointed at a different account. -->
  {#key result.identity.id}
    {#if section === 'basic'}
      <IdentityPanel
        identity={result.identity}
        profile={result.profile}
        curator={result.curator}
        canAct={data.canAct}
        {form}
        civitaiUrl={data.civitaiUrl}
      />
      <AddressesPanel {signals} />
    {:else if section === 'socials'}
      <SocialsPanel
        {signals}
        userId={result.identity.id}
        canAct={data.canAct}
        {form}
        {onSubmit}
        {submitting}
      />
    {:else if section === 'content'}
      <ContentCounts
        counts={result.counts}
        civitaiUrl={data.civitaiUrl}
        username={result.identity.username}
      />
      <CosmeticsPanel {account} />
    {:else if section === 'buzz'}
      <SubscriptionPanel
        subscription={result.subscription}
        {account}
        userId={result.identity.id}
        canAct={data.canAct}
        {form}
      />
      <BuzzHistoryPanel userId={result.identity.id} />
    {:else if section === 'prompts'}
      <PromptAuditPanel {signals} />
    {:else if section === 'shop'}
      <ShopPanel
        {account}
        userId={result.identity.id}
        canAct={data.canAct}
        {form}
        {onSubmit}
        {submitting}
      />
    {:else if section === 'generation'}
      <GenerationPanel {signals} {account} civitaiUrl={data.civitaiUrl} />
    {:else if section === 'training'}
      <TrainingsPanel {account} civitaiUrl={data.civitaiUrl} />
    {:else if section === 'bounties'}
      <BountiesPanel {account} civitaiUrl={data.civitaiUrl} />
    {:else if section === 'comments'}
      <CommentsPanel
        {account}
        userId={result.identity.id}
        canAct={data.canAct}
        {form}
        civitaiUrl={data.civitaiUrl}
        {onSubmit}
        {submitting}
      />
    {:else if section === 'leaderboard' || section === 'score'}
      <ReputationPanel stats={result.stats} scores={result.scores} ranks={result.ranks} />
    {:else if section === 'reports'}
      <ReportsPanel
        userId={result.identity.id}
        reportsFiled={result.reportsFiled}
        reportedContent={result.reportedContent}
        civitaiUrl={data.civitaiUrl}
      />
    {:else if section === 'reviews'}
      <ReviewsPanel
        {account}
        userId={result.identity.id}
        canAct={data.canAct}
        {form}
        civitaiUrl={data.civitaiUrl}
        {onSubmit}
        {submitting}
      />
    {:else if section === 'reactions'}
      <ReactionsPanel {account} />
    {:else if section === 'mod-activity'}
      <ModActivityPanel userId={result.identity.id} civitaiUrl={data.civitaiUrl} />
    {:else if section === 'chat'}
      <ChatContactPanel {signals} />
    {:else if section === 'notes'}
      <ModerationMemoryPanel userId={result.identity.id} canAct={data.canAct} {form} />
    {:else if section === 'notifications'}
      <NotificationsPanel
        {account}
        userId={result.identity.id}
        canAct={data.canAct}
        {form}
        {onSubmit}
        {submitting}
      />
    {:else}
      <!-- admin + mutes: AccountActionsPanel carries both the enforcement row and the timed-mute list. -->
      <AccountActionsPanel identity={result.identity} canAct={data.canAct} {form} />
    {/if}
  {/key}
{/if}
