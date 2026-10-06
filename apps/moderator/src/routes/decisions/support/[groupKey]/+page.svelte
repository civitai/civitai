<script lang="ts">
  import DecisionStoreNotice from '$lib/components/DecisionStoreNotice.svelte';
  import { requesterTierLabel, versionedHref } from '$lib/decisions';
  import { userLookupUrl } from '$lib/entity-url';
  import { LINK_CLASS, dateTime, plural } from '$lib/format';
  import { denied } from '$lib/permissions';
  import MemberTable from './MemberTable.svelte';
  import RulingPanel from './RulingPanel.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  const group = $derived(data.detail.group);
  const decision = $derived(data.detail.decision);
  const ticketHref = (id: string) =>
    versionedHref(`/decisions/support/ticket/${id}`, data.version, data.overridden);

  const rep = $derived(data.detail.representative);
  const repLabel = $derived(rep ? requesterTierLabel(rep.memberTier, rep.payingPriority) : null);

</script>

<header class="page-header">
  <h1>{group.title}</h1>
  <p class="text-dark-2">
    {group.topic || 'no topic'} · founded by {group.createdBy || 'unknown'} · {dateTime(group.foundedAt)}
    · version <code>{data.version}</code>
  </p>
</header>

<p class="mb-4">
  <a class={LINK_CLASS} href={versionedHref('/decisions', data.version, data.overridden)}>← All decisions</a>
</p>

<section class="mb-4 rounded-xl border border-dark-4 bg-dark-6 p-5">
  {#if group.gist}
    <!-- Customer-written text: rendered as text, never as HTML. -->
    <p class="mb-2 break-words whitespace-pre-wrap">{group.gist}</p>
  {/if}
  <p class="text-sm">
    Representative:
    {#if rep?.routed}
      <a class={LINK_CLASS} href={ticketHref(group.foundedTicketId)}>#{group.foundedTicketId}</a>
    {:else}
      #{group.foundedTicketId}
    {/if}
    <a class={LINK_CLASS} href={group.ticketUrl} target="_blank" rel="noreferrer">Freshdesk ↗</a>
    <!-- Only the FOUNDER's own details. When it has been re-routed out there is no member row to
         read them from, and borrowing another member's would attribute them to the wrong ticket. -->
    {#if rep?.civitaiUserId}
      · user
      <a class={LINK_CLASS} href={userLookupUrl(rep.civitaiUserId, 'basic')}>{rep.civitaiUserId}</a>
    {/if}
    {#if repLabel}· {repLabel}{/if}
  </p>
  {#if group.stale || group.closedAt}
    <p class="text-dark-2 mt-2 text-sm">
      This group is {group.closedAt ? `closed (${dateTime(group.closedAt)})` : 'marked stale'} — it is
      no longer offered to the router.
    </p>
  {/if}
  <ul class="mt-2 space-y-1">
    {#if data.detail.founder === 'not-first'}
      <li class="text-sm text-amber-300">
        ⚠ The founding ticket is not the oldest member — the router's oldest-first ordering broke for
        this group, so its representative may be wrong.
      </li>
    {:else if data.detail.founder === 'absent'}
      <li class="text-sm text-amber-300">
        ⚠ The founding ticket is no longer a member of this group — it was re-routed elsewhere.
      </li>
    {/if}
    {#if data.detail.topicsSpanned.length > 1}
      <li class="text-sm text-amber-300">
        ⚠ Members span {data.detail.topicsSpanned.length} topics ({data.detail.topicsSpanned.join(', ')})
        — the commonest shape of a misgrouping.
      </li>
    {/if}
  </ul>
</section>

<DecisionStoreNotice status={data.storeStatus} />

<h2 class="mb-2 text-white">
  {plural(decision?.members.length ?? 0, 'member')}
</h2>
{#if decision}
  {#key group.groupKey}
    <MemberTable
      members={decision.members}
      labels={data.memberLabels}
      version={data.version}
      {ticketHref}
      canRule={data.canRule}
    />
  {/key}
{:else}
  <p class="text-dark-2">No ticket is assigned to this group in this version.</p>
{/if}

{#if data.storeStatus === 'ok' && !data.canRule}
  <p class="text-dark-2 mt-4 text-sm">{denied('decisions.rule')}</p>
{/if}

{#key group.groupKey}
  <RulingPanel
    version={data.version}
    topic={group.topic}
    topics={data.topics}
    targets={data.targets}
    fingerprint={data.fingerprint}
    current={data.groupRuling}
    canRule={data.canRule}
  />
{/key}
