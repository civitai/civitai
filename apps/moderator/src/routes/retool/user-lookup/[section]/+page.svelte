<script lang="ts">
  import { browser } from '$app/environment';
  import type { PageData } from './$types';
  import { fetchAccount } from '../user-account';
  import { fetchSignals } from '../signals';
  import AccountActionsPanel from '../AccountActionsPanel.svelte';
  import AddressesPanel from '../AddressesPanel.svelte';
  import BountiesPanel from '../BountiesPanel.svelte';
  import BuzzBalances from '../BuzzBalances.svelte';
  import BuzzHistoryPanel from '../BuzzHistoryPanel.svelte';
  import BuzzTransactionPanel from '../BuzzTransactionPanel.svelte';
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
  import PayoutsPanel from '../PayoutsPanel.svelte';
  import TimedMutesPanel from '../TimedMutesPanel.svelte';
  import TrainingsPanel from '../TrainingsPanel.svelte';

  let { data }: { data: PageData } = $props();

  const result = $derived(data.result);
  const section = $derived(data.section);

  // Bumped after a write so the derived fetches rebuild. The panels' data comes from `/api/*`, not
  // from `load`, so invalidating the page would not bring it back.
  let version = $state(0);

  // One fetch per endpoint per section, shared by whichever panels the section renders. Fetching per
  // panel ran the account endpoint — including the 744M-row reaction scan — once per panel.
  const account = $derived(browser && result ? fetchAccount(result.identity.id, version) : null);
  const signals = $derived(browser && result ? fetchSignals(result.identity.id, version) : null);

  // Panels own their own submit state and reset it themselves; the page owns only the refresh,
  // because it owns the promises. See form-state.svelte.ts.
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
        subscription={result.subscription}
        canAct={data.canAct}
        canEditIdentity={!!data.grants['user.identity.edit']}
        civitaiUrl={data.civitaiUrl}
      />
      <!-- On the first screen because the enforcement history and the paying relationship are what it
           is read FOR; both were two clicks and a scroll away. -->
      <SubscriptionPanel subscription={result.subscription} />
      <ModerationMemoryPanel userId={result.identity.id} canAct={data.canAct} />
      <AddressesPanel {signals} />
      <!-- Folded in from its own tab: once avatar, bio and location moved onto this section, Socials
           held nothing but a link list, and a tab per list is a click that buys nothing. -->
      <SocialsPanel
        {signals}
        userId={result.identity.id}
        canAct={data.canAct}
        onSuccess={() => (version += 1)}
      />
    {:else if section === 'content'}
      <ContentCounts
        counts={result.counts}
        civitaiUrl={data.civitaiUrl}
        username={result.identity.username}
        userId={result.identity.id}
      />
      <CosmeticsPanel
        {account}
        userId={result.identity.id}
        canAct={data.canAct}
        onSuccess={() => (version += 1)}
      />
    {:else if section === 'buzz'}
      <!-- Retool split these across two tabs. Granting or deducting Buzz is a judgement made AGAINST
           the balances and the history, so hiding one behind the other made the moderator carry the
           numbers in their head. Side by side instead, with the form sticky so it survives scrolling
           a long history. The form needs its own grant; the balances and history do not. -->
      <BuzzBalances {account} />
      <div class="flex flex-col gap-4 xl:flex-row xl:items-start">
        {#if data.grants['user.buzz.send']}
          <div class="xl:sticky xl:top-4 xl:w-96 xl:shrink-0">
            <BuzzTransactionPanel
              userId={result.identity.id}
              onSuccess={() => (version += 1)}
            />
          </div>
        {/if}
        <div class="min-w-0 flex-1">
          <PayoutsPanel userId={result.identity.id} />
          <BuzzHistoryPanel userId={result.identity.id} />
        </div>
      </div>
    {:else if section === 'prompts'}
      <PromptAuditPanel {signals} />
    {:else if section === 'shop'}
      <ShopPanel
        {account}
        userId={result.identity.id}
        canAct={data.canAct}
        canGrantCosmetics={!!data.grants['user.cosmetics.grant']}
        onSuccess={() => (version += 1)}
      />
    {:else if section === 'generation'}
      <GenerationPanel {signals} userId={result.identity.id} civitaiUrl={data.civitaiUrl} />
    {:else if section === 'training'}
      <TrainingsPanel {account} userId={result.identity.id} civitaiUrl={data.civitaiUrl} />
    {:else if section === 'bounties'}
      <BountiesPanel {account} civitaiUrl={data.civitaiUrl} />
    {:else if section === 'comments'}
      <!-- No `onSuccess`: the panel keeps its own rows in step, and a refresh here would discard them. -->
      <CommentsPanel
        {account}
        userId={result.identity.id}
        canAct={data.canAct}
        civitaiUrl={data.civitaiUrl}
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
        civitaiUrl={data.civitaiUrl}
        onSuccess={() => (version += 1)}
      />
    {:else if section === 'reactions'}
      <ReactionsPanel {account} />
    {:else if section === 'mod-activity'}
      <ModActivityPanel userId={result.identity.id} civitaiUrl={data.civitaiUrl} />
    {:else if section === 'chat'}
      <ChatContactPanel modContact={result.modContact} username={result.identity.username} />
    {:else if section === 'notes'}
      <ModerationMemoryPanel userId={result.identity.id} canAct={data.canAct} />
    {:else if section === 'notifications'}
      <NotificationsPanel
        userId={result.identity.id}
        canAct={data.canAct}
        onSuccess={() => (version += 1)}
      />
    {:else if section === 'mutes'}
      <TimedMutesPanel identity={result.identity} canAct={data.canAct} />
    {:else}
      <AccountActionsPanel
        identity={result.identity}
        canAct={data.canAct}
        canToggleModerator={!!data.grants['user.moderator.toggle']}
      />
    {/if}
  {/key}
{/if}
