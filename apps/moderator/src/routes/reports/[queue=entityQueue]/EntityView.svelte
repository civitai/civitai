<script lang="ts">
  import { untrack } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import OwnerActions from '$lib/components/report-queue/OwnerActions.svelte';
  import ReadOnlyNotice from '$lib/components/report-queue/ReadOnlyNotice.svelte';
  import ReportDetailColumns from '$lib/components/report-queue/ReportDetailColumns.svelte';
  import ReportList from '$lib/components/report-queue/ReportList.svelte';
  import { FormState } from '$lib/form-state.svelte';
  import { LINK_CLASS } from '$lib/format';
  import {
    articleLookupUrl,
    bountyEntryUrl,
    bulkImageManagerUrl,
    chatAuditChatUrl,
    entityUrl,
    userLookupUrl,
  } from '$lib/entity-url';
  import { chatSubject, entityReportUrl, entryTitle } from '$lib/entity-report-queues';
  import {
    advanceAfterRuling,
    hasOpenReport,
    itemHref,
    QUEUE_NAV,
    reportActionGrants,
    reportsForItem,
  } from '$lib/report-queue';
  import type { EntityItem } from '$lib/server/entity-queue-load';
  import type { LayoutData } from './$types';
  import ArticleActions from './ArticleActions.svelte';
  import ArticlePreview from './ArticlePreview.svelte';
  import BountyPreview from './BountyPreview.svelte';
  import ChatPreview from './ChatPreview.svelte';
  import CollectionPreview from './CollectionPreview.svelte';

  // The open item, rendered the same by the bare queue (its first item) and by `[id]`: the reported
  // thing as the evidence (one preview per type), every report about it on screen, and what to do about
  // the account it belongs to. Every form holds its own result (`FormState`); the page's `form` is not
  // read.
  let { data }: { data: LayoutData & { item: EntityItem | null } } = $props();

  // Ruling and notes need only the queue; the images and the account need their action grants.
  const can = $derived(reportActionGrants(data.grants));

  const item = $derived(data.item);
  const ev = $derived(item?.evidence ?? null);
  const reports = $derived(item ? reportsForItem(item.reports, data.items, item.id) : []);
  // Which item this is, across types: a bounty and a bounty entry can share an id, and both render
  // `BountyPreview`, so a key on the id alone carried one's half-open forms into the other.
  const itemKey = $derived(item ? `${item.type}:${item.id}` : null);

  // Who a chat's reports are about, over every report the page lists — resolved ones a status filter
  // or a `?report=` link put on screen included, and every co-reporter folded into them.
  const chat = $derived(ev?.kind === 'chat' ? chatSubject(ev.members, reports) : null);
  const chatSubjectMember = $derived(
    ev?.kind === 'chat' && chat?.subjectIds.length === 1
      ? ev.members.find((m) => m.userId === chat.subjectIds[0])
      : undefined
  );

  type Link = { href: string; label: string; external?: boolean };
  type Header = {
    title: string;
    owner: { id: number; name: string | null; bannedAt: Date | null } | null;
    links: Link[];
    /** The thing is gone; its reports can still be ruled on. */
    gone: boolean;
  };

  const site = (type: string, id: number) => entityUrl(data.civitaiUrl, type, id) ?? '';

  // What the item is, whose it is, and where else to open it — per type, so the header is one markup.
  const header = $derived.by((): Header | null => {
    if (!item || !ev) return null;
    const noun = data.labels.noun;
    const gone = {
      title: `${noun[0].toUpperCase()}${noun.slice(1)} #${item.id}`,
      owner: null,
      links: [],
      gone: true,
    };
    switch (ev.kind) {
      case 'article': {
        const a = ev.article;
        if (!a) return gone;
        return {
          title: a.title || `Article #${a.id}`,
          owner: { id: a.userId, name: a.username, bannedAt: a.userBannedAt },
          links: [
            { href: site('article', a.id), label: 'on the site', external: true },
            { href: articleLookupUrl(a.id), label: 'in Article Lookup' },
          ],
          gone: false,
        };
      }
      case 'chat': {
        if (!ev.reported || !ev.members.length) return gone;
        const s = chatSubjectMember;
        return {
          // The queue row's wording, so the row and the header name the chat the same way.
          title: s ? `Chat with ${s.username ?? `#${s.userId}`}` : `Chat #${item.id}`,
          owner: null,
          links: ev.canRead ? [{ href: chatAuditChatUrl(item.id), label: 'in Chat Audit' }] : [],
          gone: false,
        };
      }
      case 'collection': {
        const c = ev.collection;
        if (!c) return gone;
        return {
          title: c.name || `Collection #${c.id}`,
          owner: { id: c.userId, name: c.username, bannedAt: c.userBannedAt },
          links: [
            { href: site('collection', c.id), label: 'on the site', external: true },
            { href: bulkImageManagerUrl('collection', c.id), label: 'in Bulk Image Manager' },
          ],
          gone: false,
        };
      }
      case 'bounty': {
        const b = ev.bounty;
        if (!b) return gone;
        return {
          title: b.name || `Bounty #${b.id}`,
          owner:
            b.userId != null ? { id: b.userId, name: b.username, bannedAt: b.userBannedAt } : null,
          links: [{ href: site('bounty', b.id), label: 'on the site', external: true }],
          gone: false,
        };
      }
      case 'bountyEntry': {
        const e = ev.entry;
        if (!e) return gone;
        return {
          title: entryTitle(e.id, ev.bounty?.name),
          owner:
            e.userId != null ? { id: e.userId, name: e.username, bannedAt: e.userBannedAt } : null,
          links: [
            {
              href: bountyEntryUrl(data.civitaiUrl, e.bountyId, e.id),
              label: 'on the site',
              external: true,
            },
            { href: site('bounty', e.bountyId), label: 'its bounty', external: true },
          ],
          gone: false,
        };
      }
    }
  });

  // The account a strike or notification goes to: the owner, or for a chat the one member its
  // reports name.
  const ownerId = $derived(
    ev?.kind === 'chat' ? (chatSubjectMember?.userId ?? null) : (ev?.ownerId ?? null)
  );

  // Which report is in flight, so one ruling does not disable every report's buttons.
  let pendingId = $state<number | null>(null);
  // Once the item has nothing left to rule, the queue moves on to the next one.
  const moveOn = advanceAfterRuling({
    items: () => data.items,
    currentId: () => item?.id,
    hasOpen: () => hasOpenReport(reports),
    open: (id) => goto(itemHref(entityReportUrl(data.queueType, id), page.url.search), QUEUE_NAV),
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

  // The ruling's error belongs to the item it was raised on. The previews and the account's actions
  // hold their own state, and are keyed on the item below.
  let shownKey: string | null = null;
  $effect.pre(() => {
    const key = itemKey;
    if (key === shownKey) return;
    shownKey = key;
    untrack(() => (reportForm.error = null));
  });
</script>

{#if item && ev && header}
  {#snippet itemHeader()}
    <header class="flex flex-col gap-1">
      <h2 class="m-0 flex flex-wrap items-center gap-2 text-lg font-semibold wrap-break-word">
        {header.title}
      </h2>
      {#if header.owner || header.links.length}
        <p class="m-0 text-sm text-muted-foreground">
          {#if header.owner}
            by
            <a href={userLookupUrl(header.owner.name ?? header.owner.id)} class={LINK_CLASS}>
              {header.owner.name ?? `#${header.owner.id}`}
            </a>
            {#if header.owner.bannedAt}<Badge variant="destructive">banned</Badge>{/if}
          {/if}
          {#each header.links as link, i (link.href)}
            {#if header.owner || i > 0}·{/if}
            <a
              href={link.href}
              class={LINK_CLASS}
              target={link.external ? '_blank' : undefined}
              rel={link.external ? 'noreferrer' : undefined}
            >
              {link.label}
            </a>
          {/each}
        </p>
      {/if}
    </header>
    <ReadOnlyNotice {can} images={ev?.kind !== 'chat'} owner={ownerId != null} />
  {/snippet}

  <ReportDetailColumns header={itemHeader}>
    {#snippet evidence()}
      {#if header.gone}
        <!-- A report outlives what it is about. Without this the column would be empty and read as a
             failed load. -->
        <p class="text-sm text-muted-foreground">
          {header.title} no longer exists. Its reports can still be ruled on.
        </p>
      {:else}
        {#key itemKey}
          {#if ev.kind === 'article'}
            <ArticlePreview evidence={ev} {can} civitaiUrl={data.civitaiUrl} />
          {:else if ev.kind === 'chat' && chat}
            <ChatPreview
              evidence={ev}
              chatId={item.id}
              subjectIds={chat.subjectIds}
              reporterIds={chat.reporterIds}
            />
          {:else if ev.kind === 'collection'}
            <CollectionPreview evidence={ev} {can} civitaiUrl={data.civitaiUrl} />
          {:else if ev.kind === 'bounty' || ev.kind === 'bountyEntry'}
            <BountyPreview evidence={ev} {can} civitaiUrl={data.civitaiUrl} />
          {/if}
        {/key}
      {/if}
    {/snippet}

    {#snippet actions()}
      <!-- 1. The reports: what was said, by whom, and the ruling on each. -->
      <ReportList
        {reports}
        canRule
        action="?/actionReport"
        onSubmit={reportForm.enhance}
        busyId={pendingId}
        error={reportForm.error}
      >
        {#snippet empty()}
          <p class="m-0 text-sm text-muted-foreground">No open reports on this {data.labels.noun}.</p>
        {/snippet}
      </ReportList>

      {#key itemKey}
        <!-- 2. What only this type can do to the thing itself. Images are acted on in the grid. -->
        {#if ev.kind === 'article' && ev.article}
          <ArticleActions article={ev.article} reportId={reports[0]?.id ?? null} />
        {/if}
      {/key}

      {#if can.strike}
        {#key itemKey}
          <!-- 3. The account it belongs to — for a chat, the member it was reported for. -->
          {#if ownerId != null}
            <OwnerActions
              userId={ownerId}
              reportId={reports[0]?.id}
              heading={ev.kind === 'chat' ? 'Act on the reported member' : undefined}
            />
          {:else if ev.kind === 'chat' && chat && reports.length && !header.gone}
            <p class="m-0 text-xs text-muted-foreground">
              {chat.rule === 'mutual'
                ? 'Both members reported each other, so neither is the one reported. Act on either from User Lookup.'
                : chat.rule === 'outsider'
                  ? 'No reporter is a member of this chat, so it names no one member. Act on a member from User Lookup.'
                  : 'A group chat report names no one member. Act on a member from User Lookup.'}
            </p>
          {/if}
        {/key}
      {/if}
    {/snippet}
  </ReportDetailColumns>
{:else}
  <p class="py-8 text-center text-sm text-muted-foreground">No reports match this view.</p>
{/if}
