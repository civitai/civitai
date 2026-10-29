<script lang="ts">
  import { untrack } from 'svelte';
  import type { LayoutData } from './$types';
  import type { AccountData } from './account.server';
  import { FormState } from '$lib/form-state.svelte';
  import { hasOpenReport, reportsForItem, advanceAfterRuling, itemHref, QUEUE_NAV } from '$lib/report-queue';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { userLookupUrl, userReportUrl } from '$lib/entity-url';
  import UserCard from '$lib/components/user-card/UserCard.svelte';
  import ReportDetailColumns from '$lib/components/report-queue/ReportDetailColumns.svelte';
  import ReadOnlyNotice from '$lib/components/report-queue/ReadOnlyNotice.svelte';
  import SuspectPanel from './SuspectPanel.svelte';
  import ReportList from '$lib/components/report-queue/ReportList.svelte';
  import AccountActions from './AccountActions.svelte';
  import InvestigateButton from '$lib/components/InvestigateButton.svelte';
  import type { ReportActionGrants } from '$lib/report-queue';

  // The open account, rendered the same by the bare queue (its first account) and by
  // `[userId]/[[tab]]`. Every form holds its own result (`FormState`), so the page's `form` is not read.
  let {
    account,
    items,
    canAct,
    canBan,
    canInvestigate,
    can,
    civitaiUrl,
  }: {
    account: AccountData | null;
    items: LayoutData['items'];
    /** Mute, ban and profile text — the `/users` page. Ruling needs only the queue. */
    canAct: boolean;
    canBan: boolean;
    /** Open a mod assistant chat on this account and its newest open report. */
    canInvestigate: boolean;
    can: ReportActionGrants;
    civitaiUrl: string;
  } = $props();

  // Which report is in flight, so one ruling does not disable every report's buttons.
  let pendingId = $state<number | null>(null);


  // Ruling on a report changes what the queue shows, and the queue comes from `load`, so this one
  // does want the reload. `onSettled` clears the marker on refusal too — a refused report that stays
  // marked reads as still working.
  // Once the account has nothing left to rule, the queue moves on to the next one.
  const moveOn = advanceAfterRuling({
    items: () => items,
    currentId: () => account?.suspectId,
    hasOpen: () => hasOpenReport(openReports),
    open: (id) => goto(itemHref(userReportUrl(id, page.params.tab), page.url.search), QUEUE_NAV),
  });
  const reportForm = new FormState({
    reload: true,
    onSubmit: ({ formData }) => {
      pendingId = Number(formData.get('id')) || null;
      moveOn.capture();
    },
    onSuccess: () => moveOn.advance(),
    onSettled: () => (pendingId = null),
  });

  const openReports = $derived(
    account ? reportsForItem(account.reports, items, account.suspectId) : []
  );

  // A refusal belongs to the account it was raised on. The account's own forms remount with it
  // (`SuspectPanel` and `AccountActions` each sit in a `{#key account.suspectId}`); this one lives above the key, so it is cleared by hand.
  let shownId: number | null = null;
  $effect.pre(() => {
    const id = account?.suspectId ?? null;
    if (id === shownId) return;
    shownId = id;
    untrack(() => (reportForm.error = null));
  });
</script>

{#if account}
  {#snippet itemHeader()}
    <!-- The account card IS the header: it carries the username, ban/mute/strike state and both links,
         so no separate heading repeats them. -->
    {#if account.details}
      <UserCard card={account.details.card} lookupLink openReports={false}>
        {#snippet actions()}
          {#if canInvestigate && account}
            <InvestigateButton userId={account.suspectId} reportId={openReports[0]?.id ?? null} />
          {/if}
        {/snippet}
      </UserCard>
    {:else}
      <h2 class="m-0 text-lg font-semibold">Account #{account.suspectId}</h2>
    {/if}
    <ReadOnlyNotice {can} images={!!account.details} owner={!!account.details} />
  {/snippet}

  <ReportDetailColumns header={itemHeader}>
    {#snippet evidence()}
      {#if account.details}
        <!-- Keyed so an open filter or selection cannot survive moving to a different account. -->
        {#key account.suspectId}
          <SuspectPanel
            suspectId={account.suspectId}
            tab={account.tab}
            details={account.details}
            suspect={account.suspect}
            models={account.models}
            filters={account.filters}
            accountHistory={account.accountHistory}
            {can}
            {civitaiUrl}
          />
        {/key}
      {:else}
        <!-- A report outlives the account it is about. Without this the column would be empty and
             read as a failed load. -->
        <p class="text-sm text-dark-2">
          Account #{account.suspectId} no longer exists. Its reports can still be ruled on.
        </p>
      {/if}
    {/snippet}

    <!-- The reports, then what to do about the account (`AccountActions`), one row per action. -->
    {#snippet actions()}
      {#key account.suspectId}
        <ReportList
          reports={openReports}
          canRule
          action="?/actionReport"
          onSubmit={reportForm.enhance}
          busyId={pendingId}
          error={reportForm.error}
        >
          {#snippet empty()}
            <!-- Every report on the account is ruled on, or it was opened from a link (User Lookup,
                 the dashboard) for an account with none open. -->
            <p class="m-0 text-sm text-muted-foreground">
              No open reports on this account.
              <a href={userLookupUrl(account.suspectId, 'reports')} class="link">
                All its reports in User Lookup
              </a>
            </p>
          {/snippet}
        </ReportList>

        {#if (canAct || can.strike || page.data.grants?.['user.message.asCivitai']) && account.details}
          <AccountActions
            suspectId={account.suspectId}
            {canBan}
            canStrike={can.strike}
            canEnforce={canAct}
            account={{
              username: account.details.card.identity.username,
              bannedAt: account.details.card.identity.bannedAt,
              banReason: account.details.card.identity.banReason,
              bannedBy: account.bannedBy,
              muted: !!account.details.card.identity.muted,
              mutedUntil: account.timedMute?.muteExpiresAt ?? null,
              profile: account.details.profile,
            }}
          />
        {/if}
      {/key}
    {/snippet}
  </ReportDetailColumns>
{:else}
  <p class="py-8 text-center text-sm text-muted-foreground">No reports match this view.</p>
{/if}
