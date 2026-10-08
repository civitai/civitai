<script lang="ts">
  import type { Snippet } from 'svelte';
  import { page } from '$app/state';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import {
    Sheet,
    SheetContent,
    SheetHeader,
    SheetTitle,
  } from '@civitai/ui/components/ui/sheet/index.js';
  import { cn } from '@civitai/ui/utils.js';
  import { getBrowsingLevelLabel } from '@civitai/shared';
  import { LINK_CLASS, dateTime, type Jsonified } from '$lib/format';
  import { chatAuditChatUrl, userLookupUrl, userUrl } from '$lib/entity-url';
  import { ReportEntity, reportActionPath } from '$lib/reports';
  import type { UserCard } from '$lib/server/user-lookup.service';
  import type { CsamReportRow } from '$lib/server/user-account.service';

  let {
    card,
    compact = false,
    lookupLink = false,
    actions,
    class: className,
  }: {
    /** From a page load (Dates) or from `/api/user-card` (strings); its dates are only tested, never
     *  formatted, so either shape renders the same. */
    card: UserCard | Jsonified<UserCard>;
    /** The popover: no side sheet, which would unmount with the popover the moment it opened. */
    compact?: boolean;
    /** Off on User Lookup itself, where the card already sits on the account's page. */
    lookupLink?: boolean;
    actions?: Snippet;
    class?: string;
  } = $props();

  const identity = $derived(card.identity);
  const profileUrl = $derived(
    identity.username ? userUrl(page.data.civitaiUrl, identity.username) : null
  );

  let showModChats = $state(false);

  // Fetched only once opened. The endpoint returns each report's CLASSIFICATION, never its material.
  let csamOpen = $state(false);
  const csamReports = $derived(
    csamOpen
      ? fetch(`/api/user-csam-reports/${identity.id}`).then(
          (r): Promise<Jsonified<CsamReportRow>[]> =>
            r.ok ? r.json() : Promise.reject(new Error(String(r.status)))
        )
      : null
  );
</script>

<div class={cn('rounded-xl border border-dark-4 bg-dark-6', compact ? 'p-3' : 'px-5 py-3', className)}>
  <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
    <h2 class={cn('font-semibold text-white', compact ? 'text-base' : 'text-lg')}>
      {#if profileUrl}
        <a href={profileUrl} target="_blank" rel="noreferrer" class={LINK_CLASS}>
          {identity.username}
        </a>
      {:else}
        (no username)
      {/if}
    </h2>
    <code class="text-sm text-dark-2">#{identity.id}</code>
    {#if identity.bannedAt}
      <!-- The reason decides what a moderator does next — a Nudify ban and a SexualMinor ban are not
           the same conversation — so it rides on the badge. -->
      <Badge variant="destructive">
        banned{identity.banReason ? `: ${identity.banReason}` : ''}
      </Badge>
      {#if identity.banReason?.startsWith('SexualMinor')}
        <Badge variant="destructive">CSAM ban</Badge>
      {/if}
    {/if}
    <!-- Outside the `bannedAt` block on purpose: a contest ban leaves the account otherwise in good
         standing, so nothing else on the page reflects it. -->
    {#if identity.contestBannedAt}
      <Badge variant="secondary">contest banned</Badge>
    {/if}
    {#if identity.csamReportCount > 0}
      {@const label = `CSAM report${identity.csamReportCount > 1 ? ` ×${identity.csamReportCount}` : ''}`}
      {#if compact}
        <Badge variant="destructive">{label}</Badge>
      {:else}
        <button type="button" onclick={() => (csamOpen = true)} class="cursor-pointer">
          <Badge variant="destructive" class="underline decoration-dotted underline-offset-2">
            {label}
          </Badge>
        </button>
      {/if}
    {/if}
    {#if identity.muted}<Badge variant="destructive">muted</Badge>{/if}
    <!-- A Pending restriction is a SYSTEM mute nobody has ruled on; without it that account reads as an
         unexplained manual mute. -->
    {#if identity.restrictionStatus}
      <Badge variant={identity.restrictionStatus === 'Pending' ? 'destructive' : 'secondary'}>
        {identity.restrictionType ?? 'restriction'}: {identity.restrictionStatus}
      </Badge>
    {/if}
    {#if !identity.onboarding}<Badge variant="secondary">TOS not accepted</Badge>{/if}
    {#if identity.excludeFromLeaderboards}
      <Badge variant="secondary">excluded from leaderboards</Badge>
    {/if}
    {#if identity.deletedAt}<Badge variant="secondary">deleted</Badge>{/if}
    {#if identity.isModerator}<Badge variant="secondary">moderator</Badge>{/if}
    {#if card.curator.isCurator}<Badge variant="secondary">curator</Badge>{/if}
    {#if card.strikes.count}
      <Badge variant="destructive">
        {card.strikes.count} active strike{card.strikes.count > 1 ? 's' : ''}
        ({card.strikes.points} pt{card.strikes.points > 1 ? 's' : ''})
      </Badge>
    {/if}
    {#if card.strikeCountAllTime}
      <Badge variant="secondary">{card.strikeCountAllTime} all-time</Badge>
    {/if}
    {#if card.subscription?.productName}
      <!-- Status is carried, not assumed: a cancelled subscription must not read as a paying one. -->
      <Badge variant="secondary">
        {card.subscription.productName}{card.subscription.status === 'active'
          ? ''
          : ` (${card.subscription.status})`}
      </Badge>
    {/if}
    {#if card.modContact.chats}
      <button
        type="button"
        onclick={() => (showModChats = !showModChats)}
        aria-expanded={showModChats}
        class="cursor-pointer"
      >
        <!-- Red: the mod team reads this chip as enforcement history. -->
        <Badge variant="destructive">
          spoke with a mod ×{card.modContact.chats}
          <span aria-hidden="true">{showModChats ? '▾' : '▸'}</span>
        </Badge>
      </button>
    {/if}
    {#if identity.browsingLevel}
      <Badge variant="secondary">Viewing: {getBrowsingLevelLabel(identity.browsingLevel)}</Badge>
    {/if}
    {#if identity.email}
      <span class="text-xs text-dark-2">{identity.email}</span>
    {/if}

    {#if lookupLink || actions}
      <span class="ml-auto flex items-center gap-3 self-center">
        {#if lookupLink}
          <a href={userLookupUrl(identity.id)} class="text-xs {LINK_CLASS}">Open in User Lookup</a>
        {/if}
        {@render actions?.()}
      </span>
    {/if}
  </div>

  {#if showModChats}
    {@const chats = card.modContact.chats ?? 0}
    <ul class="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-sm">
      {#each card.modContact.chatIds as id (id)}
        <li><a href={chatAuditChatUrl(id)} class={LINK_CLASS}>chat {id}</a></li>
      {/each}
      {#if chats > card.modContact.chatIds.length}
        <li class="text-xs text-dark-2">
          +{chats - card.modContact.chatIds.length} more, in User Lookup's Chat section
        </li>
      {/if}
    </ul>
  {/if}

  <!-- A report nobody has ruled on changes what everything else about the account means, so it sits
       in the card wherever the card is. -->
  {#if identity.openReportCount > 0}
    <div
      class="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-200"
      role="status"
    >
      <span class="flex flex-wrap items-center gap-2">
        {identity.openReportCount} open report{identity.openReportCount > 1 ? 's' : ''} against this
        account.
        <!-- The moderator who filed is the anti-overlap signal: a colleague is already on it. -->
        {#if identity.openReportModerators}
          <Badge variant="outline">filed by {identity.openReportModerators}</Badge>
        {/if}
      </span>
      <a href="/retool/user-reports?user={identity.id}" class={LINK_CLASS}>
        Work this account's reports
      </a>
    </div>
  {/if}
</div>

{#if !compact}
  <Sheet bind:open={csamOpen}>
    <SheetContent side="right" class="w-full overflow-y-auto sm:max-w-lg">
      <SheetHeader>
        <SheetTitle>CSAM reports</SheetTitle>
      </SheetHeader>
      <div class="flex flex-col gap-4 px-4 pb-6 text-sm">
        <p class="text-xs text-dark-2">
          What each report classified this account under, and whether it was sent. The reported material
          is not shown here.
        </p>
        {#if csamReports}
          {#await csamReports}
            <p class="text-dark-2">Loading reports…</p>
          {:then reports}
            {#if reports.length === 0}
              <p class="text-dark-2">No report rows — the count and the table disagree.</p>
            {:else}
              {#each reports as r (r.id)}
                <div class="rounded-lg border border-dark-4 bg-dark-6 p-4">
                  <div class="flex flex-wrap items-baseline gap-x-2">
                    <span class="font-medium text-white">#{r.id}</span>
                    <Badge variant="secondary">{r.type}</Badge>
                    {#if r.reportSentAt}
                      <Badge variant="destructive">sent {dateTime(r.reportSentAt)}</Badge>
                    {:else}
                      <Badge variant="outline">not sent</Badge>
                    {/if}
                    {#if r.archivedAt}<Badge variant="secondary">archived</Badge>{/if}
                    {#if r.contentRemovedAt}<Badge variant="secondary">content removed</Badge>{/if}
                  </div>
                  <dl class="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
                    <dt class="text-dark-2">Filed</dt>
                    <dd class="text-dark-0">
                      {dateTime(r.createdAt)}{r.reportedByUsername ? ` by ${r.reportedByUsername}` : ''}
                    </dd>
                    {#if r.minorDepiction}
                      <dt class="text-dark-2">Minor depiction</dt>
                      <dd class="text-dark-0">{r.minorDepiction}</dd>
                    {/if}
                    {#if r.contents.length}
                      <dt class="text-dark-2">Contents</dt>
                      <dd class="text-dark-0">{r.contents.join(', ')}</dd>
                    {/if}
                    <dt class="text-dark-2">Attached</dt>
                    <dd class="text-dark-0">
                      {r.imageCount} image{r.imageCount === 1 ? '' : 's'}, {r.modelVersionCount} model version{r.modelVersionCount ===
                        1
                        ? ''
                        : 's'}{r.userActivityCount
                        ? `, ${r.userActivityCount.toLocaleString()} activity ${
                            r.userActivityCount === 1 ? 'entry' : 'entries'
                          }`
                        : ''}
                    </dd>
                  </dl>
                  {#if r.reportId}
                    <a
                      href={reportActionPath(ReportEntity.User, r.reportId)}
                      class="mt-3 inline-block text-xs {LINK_CLASS}"
                    >
                      Originating report #{r.reportId}
                    </a>
                  {/if}
                </div>
              {/each}
            {/if}
          {:catch}
            <p class="text-red-300">Could not load the CSAM reports for this account.</p>
          {/await}
        {/if}
      </div>
    </SheetContent>
  </Sheet>
{/if}
