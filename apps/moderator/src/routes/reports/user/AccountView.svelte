<script lang="ts">
  import { untrack } from 'svelte';
  import type { LayoutData } from './$types';
  import type { AccountData } from './account.server';
  import { FormState } from '$lib/form-state.svelte';
  import { hasOpenReport, nextItemId, reportsForItem } from '$lib/report-queue';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { userLookupUrl, userReportUrl } from '$lib/entity-url';
  import { clearPaging } from '$lib/paging';
  import UserCard from '$lib/components/user-card/UserCard.svelte';
  import ReportDetailColumns from '$lib/components/report-queue/ReportDetailColumns.svelte';
  import SuspectPanel from './SuspectPanel.svelte';
  import ReportList from '$lib/components/report-queue/ReportList.svelte';
  import AccountActions from './AccountActions.svelte';

  // The open account, rendered the same by the bare queue (its first account) and by
  // `[userId]/[[tab]]`. Every form holds its own result (`FormState`), so the page's `form` is not read.
  let {
    account,
    items,
    canAct,
    canBan,
    civitaiUrl,
  }: {
    account: AccountData | null;
    items: LayoutData['items'];
    canAct: boolean;
    canBan: boolean;
    civitaiUrl: string;
  } = $props();

  // Which report is in flight, so one ruling does not disable every report's buttons.
  let pendingId = $state<number | null>(null);


  // Ruling on a report changes what the queue shows, and the queue comes from `load`, so this one
  // does want the reload. `onSettled` clears the marker on refusal too — a refused report that stays
  // marked reads as still working.
  let formerIndex = -1;
  const reportForm = new FormState({
    reload: true,
    onSubmit: ({ formData }) => {
      pendingId = Number(formData.get('id')) || null;
      formerIndex = items.findIndex((r) => r.entityId === account?.suspectId);
    },
    // Once the account has nothing left to rule, the queue moves on to the next one, as ruling a
    // report always moved it on to the next row. Read after the reload: the list is the new one.
    onSuccess: () => {
      if (!account || hasOpenReport(openReports)) return;
      const next = nextItemId(items, formerIndex, account.suspectId);
      if (next == null) return;
      const params = new URLSearchParams(page.url.search);
      params.delete('report');
      clearPaging(params);
      const query = params.size ? `?${params}` : '';
      goto(`${userReportUrl(next, page.params.tab)}${query}`, { noScroll: true, keepFocus: true });
    },
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
  <!-- The account card IS the header — who this is, its ban/mute/strike state, and the User Lookup and
       site links. A heading above it repeated the username and both links. It sits across both
       columns because that state decides what every tab's evidence and every action means. -->
  {#if account.details}
    <UserCard card={account.details.card} lookupLink openReports={false} />
  {:else}
    <h2 class="m-0 text-lg font-semibold">Account #{account.suspectId}</h2>
  {/if}
  {#if !canAct}
    <p class="m-0 text-xs text-muted-foreground">
      Read-only: ruling on a report or acting on an account needs access to the Users page
      (`/users`), granted on `/admin`.
    </p>
  {/if}

  <ReportDetailColumns>
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
            {canAct}
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
          canRule={canAct}
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

        {#if canAct && account.details}
          <AccountActions
            suspectId={account.suspectId}
            {canBan}
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
