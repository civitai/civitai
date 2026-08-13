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
  import TrainingsPanel from '../TrainingsPanel.svelte';

  let { data, form }: { data: PageData; form: FormResult } = $props();

  // `fail()` payloads collapse to a union across every action on this page, so the conflict shape has
  // to be recovered with a runtime check rather than read off the type.
  type PaddleConflict = { id: number; username: string | null; paddleCustomerId: string };
  const paddleConflict = $derived.by((): PaddleConflict | null => {
    const value = form && 'paddleConflict' in form ? form.paddleConflict : null;
    return value && typeof value === 'object' && 'id' in value ? (value as PaddleConflict) : null;
  });

  const result = $derived(data.result);
  const section = $derived(data.section);

  // Bumped after a write so the derived fetches rebuild. The panels' data comes from `/api/*`, not
  // from `load`, so invalidating the page would not bring it back.
  let version = $state(0);
  let submitting = $state(false);

  // One fetch per endpoint per section, shared by whichever panels the section renders. Fetching per
  // panel ran the account endpoint — including the 744M-row reaction scan — once per panel.
  const account = $derived(browser && result ? fetchAccount(result.identity.id, version) : null);
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
        subscription={result.subscription}
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
        userId={result.identity.id}
      />
      <CosmeticsPanel
        {account}
        userId={result.identity.id}
        canAct={data.canAct}
        {form}
        {onSubmit}
        {submitting}
      />
    {:else if section === 'buzz'}
      <!-- Retool split these across two tabs. Granting or deducting Buzz is a judgement made AGAINST
           the balances and the history, so hiding one behind the other made the moderator carry the
           numbers in their head. Side by side instead, with the form sticky so it survives scrolling
           a long history. Only a senior moderator sees it. -->
      <BuzzBalances {account} />
      <div class="flex flex-col gap-4 xl:flex-row xl:items-start">
        {#if data.canSendBuzz}
          <div class="xl:sticky xl:top-4 xl:w-96 xl:shrink-0">
            <BuzzTransactionPanel
              userId={result.identity.id}
              {form}
              onWritten={() => (version += 1)}
            />
          </div>
        {/if}
        <div class="min-w-0 flex-1">
          <SubscriptionPanel
            subscription={result.subscription}
            userId={result.identity.id}
            paddleCustomerId={result.identity.paddleCustomerId}
            canAct={data.canAct}
            error={form && 'scope' in form && form.scope === 'account' ? (form.error ?? null) : null}
            conflict={paddleConflict}
          />
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
        {form}
        {onSubmit}
        {submitting}
      />
    {:else if section === 'generation'}
      <GenerationPanel {signals} userId={result.identity.id} civitaiUrl={data.civitaiUrl} />
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
      <ChatContactPanel modContact={result.modContact} />
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
      <AccountActionsPanel
        identity={result.identity}
        canAct={data.canAct}
        isSenior={data.isSenior}
        {form}
      />
    {/if}
  {/key}
{/if}
