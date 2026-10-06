<script lang="ts">
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import DecisionStoreNotice from '$lib/components/DecisionStoreNotice.svelte';
  import { versionedHref } from '$lib/decisions';
  import { LINK_CLASS, dateTime, plural } from '$lib/format';
  import { denied } from '$lib/permissions';
  import MemberTable from './MemberTable.svelte';
  import RulingPanel from './RulingPanel.svelte';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  const group = $derived(data.detail.group);
  const decision = $derived(data.detail.decision);
  const ticketHref = (id: string) =>
    versionedHref(`/decisions/support/ticket/${id}`, data.version, data.overridden);

  // One `form` serves both actions; each panel renders only its own refusal. `denied` comes from
  // `requiresGrant` and belongs to whichever panel was used, so the ruling panel shows it.
  const ruleError = $derived(
    form && 'error' in form && form.error && (form.scope === 'rule' || form.scope === 'denied')
      ? form.error
      : null
  );
  const labelError = $derived(
    form && 'error' in form && form.error && form.scope === 'label' && 'ticketId' in form && form.ticketId
      ? { ticketId: form.ticketId, message: form.error }
      : null
  );
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
    {#if decision?.lead.routed}
      <a class={LINK_CLASS} href={ticketHref(group.foundedTicketId)}>#{group.foundedTicketId}</a>
    {:else}
      #{group.foundedTicketId}
    {/if}
    <a class={LINK_CLASS} href={group.ticketUrl} target="_blank" rel="noreferrer">Freshdesk ↗</a>
    {#if decision?.lead.civitaiUserId}
      · user
      <a class={LINK_CLASS} href="/retool/user-lookup/basic?q={decision.lead.civitaiUserId}"
        >{decision.lead.civitaiUserId}</a
      >
    {/if}
    {#if decision?.lead.memberTier}· {decision.lead.memberTier}{/if}
    {#if decision?.lead.payingPriority}<Badge variant="outline" class="ml-1">paying priority</Badge>{/if}
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
      error={labelError}
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
    current={data.groupRuling}
    canRule={data.canRule}
    error={ruleError}
  />
{/key}
