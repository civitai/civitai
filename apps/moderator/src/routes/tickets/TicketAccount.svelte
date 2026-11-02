<script lang="ts">
  import TriageCard from '$lib/components/triage/TriageCard.svelte';
  import { userLookupUrl } from '$lib/entity-url';
  import { LINK_CLASS, dateTime, relativeTime } from '$lib/format';
  import { denied } from '$lib/permissions';
  import type { TicketAccount } from '$lib/server/tickets/account';
  import { BAN_PERMISSION_NEEDED } from '$lib/site-appeals';
  import TicketAccountAction from './TicketAccountAction.svelte';
  import TicketAppealRuling from './TicketAppealRuling.svelte';
  import TicketRestrictionRuling from './TicketRestrictionRuling.svelte';

  let {
    ticketId,
    account,
    canAct = false,
    canUnban = false,
    readOnly = false,
    ondone,
  }: {
    ticketId: string;
    account: TicketAccount;
    /** The `/users` page grant, which mutes and restriction rulings need in User Lookup too. */
    canAct?: boolean;
    /** The `user.ban` permission, which an unban needs in User Lookup too. */
    canUnban?: boolean;
    /** The support card: status only, no appeal ruling and no actions. */
    readOnly?: boolean;
    ondone: (what: string, data: Record<string, unknown> | undefined) => void;
  } = $props();

  const NEEDS_USERS = 'This action requires access to the Users page.';
  const unbanWhy = denied('user.ban');

  // Approving an Account appeal lifts the ban and the mute through the same service as the queue.
  const approvalText = $derived.by(() => {
    if (account.status !== 'ok') return '';
    const lifts = [account.banned && 'the ban', account.muted && 'the mute'].filter(Boolean);
    return lifts.length
      ? `Approving lifts ${lifts.join(' and ')}.`
      : 'The account is no longer restricted, so approving lifts nothing.';
  });
</script>

<TriageCard title="Account" dense>
  {#if account.status === 'unlinked'}
    <p class="m-0 text-dark-2">No linked Civitai account — actions unavailable</p>
  {:else if account.status === 'unavailable'}
    <p class="m-0 text-amber-300">
      Account status unavailable.
      <a class={LINK_CLASS} href={userLookupUrl(account.userId, 'basic')}>User #{account.userId}</a>
    </p>
  {:else}
    <dl class="m-0 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1">
      <dt class="text-dark-2">User</dt>
      <dd class="m-0 min-w-0 break-words">
        <a class={LINK_CLASS} href={userLookupUrl(account.userId, 'basic')}>
          {account.username ?? 'No username'} (#{account.userId})
        </a>
      </dd>
      {#if account.email !== undefined}
        <dt class="text-dark-2">Email</dt>
        <dd class="m-0 min-w-0 break-all text-white">{account.email ?? '—'}</dd>
      {/if}
      {#if account.emailVerified !== undefined}
        <dt class="text-dark-2">Verified</dt>
        <dd class="m-0 min-w-0 break-words text-white">
          {#if account.emailVerified}
            <span title={dateTime(account.emailVerified)}>{dateTime(account.emailVerified)}</span>
          {:else}
            Not verified
          {/if}
        </dd>
      {/if}
      <dt class="text-dark-2">Banned</dt>
      <dd class="m-0 min-w-0 break-words text-white">
        {#if account.banned}
          Yes{#if account.banned.since}
            <span class="text-dark-2" title={dateTime(account.banned.since)}>
              · {relativeTime(account.banned.since)}</span
            >{/if}{#if account.banned.reason}<span class="text-dark-2"> · {account.banned.reason}</span>{/if}
        {:else}
          No
        {/if}
      </dd>
      <dt class="text-dark-2">Muted</dt>
      <dd class="m-0 min-w-0 break-words text-white">
        {#if account.timedMute}
          Until <span title={dateTime(account.timedMute.until)}>{dateTime(account.timedMute.until)}</span>
          {#if account.timedMute.reason}<span class="text-dark-2"> · {account.timedMute.reason}</span>{/if}
        {:else if account.muted}
          Yes
        {:else}
          No
        {/if}
      </dd>
    </dl>

    {#if account.restrictions.length > 0}
      <h4 class="m-0 mt-2 mb-1 text-[11px] font-semibold tracking-[0.5px] text-dark-2 uppercase">
        Restrictions
      </h4>
      <ul class="m-0 flex list-none flex-col gap-1 p-0">
        {#each account.restrictions as r (r.id)}
          <li class="text-white">
            #{r.id} · {r.type} · {r.status}
            <span class="text-dark-2" title={dateTime(r.createdAt)}>· {relativeTime(r.createdAt)}</span>
          </li>
        {/each}
      </ul>
    {/if}

    {#if account.pendingAppeal && !readOnly}
      {@const appeal = account.pendingAppeal}
      <div class="mt-2 flex flex-col gap-1.5 border-t border-dark-4 pt-2">
        <h4 class="m-0 text-[11px] font-semibold tracking-[0.5px] text-dark-2 uppercase">
          Pending appeal #{appeal.id}
          <span class="font-normal normal-case" title={dateTime(appeal.createdAt)}>
            · filed {relativeTime(appeal.createdAt)}
          </span>
        </h4>
        <p class="m-0 min-w-0 break-words whitespace-pre-wrap text-white">{appeal.message}</p>
        <p class="m-0 text-dark-2">{approvalText}</p>
        <TicketAppealRuling
          {ticketId}
          userId={account.userId}
          appealId={appeal.id}
          kind="account"
          blocked={account.banned && !canUnban ? BAN_PERMISSION_NEEDED : null}
          {ondone}
        />
      </div>
    {/if}

    {#if !readOnly && (account.banned || account.muted || account.restrictions.some((r) => r.rulable))}
      <div class="mt-2 flex flex-col gap-2 border-t border-dark-4 pt-2">
        {#if account.banned}
          <TicketAccountAction
            {ticketId}
            userId={account.userId}
            action="accountUnban"
            label="Unban"
            confirmText="The account is unbanned. Nothing is emailed from here."
            doneLabel="Account unbanned"
            enabled={canUnban}
            why={unbanWhy}
            {ondone}
          />
        {/if}
        {#if account.timedMute}
          <TicketAccountAction
            {ticketId}
            userId={account.userId}
            action="accountLiftTimedMute"
            label="Lift timed mute"
            confirmText="The account can post again straight away."
            doneLabel="Timed mute lifted"
            enabled={canAct}
            why={NEEDS_USERS}
            {ondone}
          />
        {:else if account.muted}
          <TicketAccountAction
            {ticketId}
            userId={account.userId}
            action="accountUnmute"
            label="Unmute"
            confirmText="The account can post again straight away."
            doneLabel="Account unmuted"
            enabled={canAct}
            why={NEEDS_USERS}
            {ondone}
          />
        {/if}
        {#each account.restrictions.filter((r) => r.rulable) as r (r.id)}
          <TicketRestrictionRuling
            {ticketId}
            userId={account.userId}
            restrictionId={r.id}
            enabled={canAct}
            why={NEEDS_USERS}
            {ondone}
          />
        {/each}
      </div>
    {/if}
  {/if}
</TriageCard>
