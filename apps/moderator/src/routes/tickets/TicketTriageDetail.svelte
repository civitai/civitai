<script lang="ts">
  import { browser } from '$app/environment';
  import { invalidateAll } from '$app/navigation';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { toast } from '@civitai/ui/components/ui/sonner/index.js';
  import TriageCard from '$lib/components/triage/TriageCard.svelte';
  import ReportDetailColumns from '$lib/components/report-queue/ReportDetailColumns.svelte';
  import { userLookupUrl } from '$lib/entity-url';
  import { LINK_CLASS, dateTime, relativeTime } from '$lib/format';
  import { keepLast } from '$lib/keep-last.svelte';
  import type { TicketPayload } from '$lib/server/tickets/detail';
  import type { TicketRow } from '$lib/server/tickets/list';
  import type { PanelSections } from '$lib/server/tickets/panels';
  import { createDetailLoader } from '$lib/tickets/fetch-detail';
  import { closedOut } from '$lib/tickets/outcome';
  import { requesterLabel, sentByText } from '$lib/tickets/row';
  import type { TicketView } from '$lib/tickets/routing';
  import { splitTags } from '$lib/tickets/tags';
  import TicketAccount from './TicketAccount.svelte';
  import TicketAppeals from './TicketAppeals.svelte';
  import TicketContentReports from './TicketContentReports.svelte';
  import TicketEscalate from './TicketEscalate.svelte';
  import TicketGeneratorRestrictions from './TicketGeneratorRestrictions.svelte';
  import TicketHistory from './TicketHistory.svelte';
  import TicketLoraRuns from './TicketLoraRuns.svelte';
  import TicketRatingDisputes from './TicketRatingDisputes.svelte';
  import TicketReply from './TicketReply.svelte';
  import TicketStatusMenu from './TicketStatusMenu.svelte';

  let {
    row,
    view,
    canReply,
    canEscalate,
    canAccountAct,
    canUnban,
    onleave,
  }: {
    row: TicketRow;
    view: TicketView;
    canReply: boolean;
    canEscalate: boolean;
    canAccountAct: boolean;
    canUnban: boolean;
    /** The ticket no longer belongs in this list (another view, or resolved): move to the next one. */
    onleave: (id: string) => void;
  } = $props();

  // Bumped by a write to re-read the detail.
  let version = $state(0);
  // Depend on the id alone: every write re-reads the list and hands over a new `row` object, which would refetch the detail each time. `keepLast` holds the last read through a refetch so a write does not blank the pane or unmount the Account card.
  const id = $derived(row.id);
  const loader = createDetailLoader();
  const detail = keepLast(() => {
    void version;
    return browser ? loader.load(id, view) : null;
  });
  $effect(() => loader.cancel);
  // The pane is remounted per ticket; still never show another ticket's read.
  const read = $derived(
    detail.value?.ok && detail.value.payload.ticket.id === row.id ? detail.value : null
  );
  // Tags arrive with the detail read; null until then.
  const tagSplit = $derived(read ? splitTags(read.payload.ticket.tags) : null);
  const failure = $derived(detail.value && !detail.value.ok ? detail.value.message : null);
  // The reply and the status menu both write the ticket's status, so one waits while the other is in flight.
  let replying = $state(false);
  let changingStatus = $state(false);

  function done(what: string, data: Record<string, unknown> | undefined, status: number | null) {
    const moved = data?.moved;
    const warning = typeof data?.warning === 'string' ? data.warning : null;
    const left = moved === 'moderation' || moved === 'support';
    if (left || closedOut(data, status)) {
      const where = left ? `${what}; it is now in the ${moved} view` : `${what}; it is closed out`;
      if (warning) toast.warning(`${where}. ${warning}`);
      else toast.success(where);
      onleave(row.id);
      return;
    }
    version += 1;
    void invalidateAll();
    if (warning) toast.warning(`${what}. ${warning}`);
    else toast.success(what);
  }

  // An account change never moves the ticket, so only the detail is re-read.
  function accountDone(what: string, data: Record<string, unknown> | undefined) {
    version += 1;
    const warning = typeof data?.warning === 'string' ? data.warning : null;
    if (warning) toast.warning(`${what}. ${warning}`);
    else toast.success(what);
  }

  const title = $derived(row.subject || '(no subject)');
</script>

{#snippet header()}
  {@const kind = row.cfFeature ?? row.routerTopic}
  {@const sentBy = read ? read.payload.ticket.sentBy : row.sentBy}
  {@const sentText = sentByText({ sentToSupport: row.sentToSupport, sentBy })}
  {@const rest = tagSplit?.rest ?? []}
  <div class="min-w-0 space-y-1.5">
    <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
      <h2 class="m-0 text-lg font-semibold break-words text-white">{title}</h2>
      <TicketStatusMenu
        ticketId={row.id}
        status={row.status}
        label={row.statusLabel}
        {canReply}
        ondone={done}
        bind:submitting={changingStatus}
        locked={replying}
      />
      {#if kind}
        <Badge variant="outline" class="border-dark-4 bg-transparent text-dark-1">{kind}</Badge>
      {/if}
    </div>
    <p class="m-0 flex flex-wrap items-center gap-x-1.5 text-sm text-dark-2">
      <a
        class="{LINK_CLASS} tabular-nums"
        href={row.freshdeskUrl}
        target="_blank"
        rel="noreferrer"
        title="Open in Freshdesk"
        aria-label="Open ticket {row.id} in Freshdesk">#{row.id} ↗</a
      >
      <span aria-hidden="true">·</span>
      <span>
        created <span title={dateTime(row.createdAt)}>{relativeTime(row.createdAt)}</span>
        · updated <span title={dateTime(row.updatedAt)}>{relativeTime(row.updatedAt)}</span>
      </span>
      {#if sentText}
        <span aria-hidden="true">·</span>
        <span>
          {sentText}{#if sentBy}<span> · {dateTime(sentBy.at)}</span>{/if}
        </span>
      {/if}
    </p>
    {#if rest.length > 0}
      <ul class="m-0 flex list-none flex-wrap gap-1 p-0">
        {#each rest as tag (tag)}
          <li class="rounded-full border border-dark-4 px-2 py-px text-xs text-dark-2">{tag}</li>
        {/each}
      </ul>
    {/if}
  </div>
{/snippet}

<!-- 🔴 TEXT, NEVER `{@html}`: the description and every message are customer-written. -->
{#snippet evidence()}
  <!-- The middle column scrolls as one box; the composer sticks to its bottom edge on wide screens and flows on narrow ones. -->
  <div class="flex min-h-full flex-col">
    <div class="flex-1">
      {#if read}
        {#if read.stale}
          <p class="m-0 mb-3 text-xs text-amber-300" role="status">
            Showing the last read of this ticket: {read.stale}
          </p>
        {/if}
        {@render ticketBody(read.payload)}
      {:else if failure}
        <p class="m-0 text-sm text-red-300" role="alert">Could not read the ticket: {failure}</p>
      {:else}
        <p class="m-0 text-sm text-dark-2">Loading the ticket from Freshdesk…</p>
      {/if}
    </div>
    {@render composer()}
  </div>
{/snippet}

{#snippet ticketBody(p: TicketPayload)}
  <section class="mb-5">
    <h3 class="m-0 mb-2 text-[11px] font-semibold tracking-[0.5px] text-dark-2 uppercase">Ticket</h3>
    {#if p.ticket.description.status === 'found'}
      <p class="m-0 text-sm break-words whitespace-pre-wrap text-white">{p.ticket.description.text}</p>
      {#if p.ticket.description.truncated}
        <p class="m-0 mt-2 text-xs text-dark-2">Cut short here — the rest is in Freshdesk.</p>
      {/if}
    {:else if p.ticket.description.status === 'none'}
      <p class="m-0 text-sm text-dark-2">Freshdesk has no description for this ticket.</p>
    {:else}
      <p class="m-0 text-sm text-dark-2">{p.ticket.description.reason}</p>
    {/if}
  </section>

  <section>
    <h3 class="m-0 mb-1 text-[11px] font-semibold tracking-[0.5px] text-dark-2 uppercase">
      Conversation
    </h3>
    <p class="m-0 mb-3 text-xs text-dark-2">
      Customer messages and public agent replies, oldest first. Private notes are not shown.
    </p>
    {#if p.conversation.status === 'found'}
      {#if p.conversation.messages.length === 0}
        <p class="m-0 text-sm text-dark-2">No messages beyond the original ticket.</p>
      {/if}
      <ol class="m-0 flex list-none flex-col gap-3 p-0">
        {#each p.conversation.messages as m (m.conversationId)}
          <li class="rounded-lg border border-dark-4 bg-dark-7 p-3">
            <p class="m-0 mb-1 text-xs text-dark-2">
              {m.from === 'customer' ? 'Customer' : 'Agent'} · {dateTime(m.createdAt)}
            </p>
            <p class="m-0 text-sm break-words whitespace-pre-wrap text-white">{m.text}</p>
          </li>
        {/each}
      </ol>
      {#if p.conversation.truncated}
        <p class="m-0 mt-2 text-xs text-dark-2">
          Only the earliest messages are shown — the rest is in Freshdesk.
        </p>
      {/if}
    {:else}
      <p class="m-0 text-sm text-red-300">Could not read the conversation: {p.conversation.reason}</p>
    {/if}
  </section>
{/snippet}

{#snippet composer()}
  <section
    class="-mx-5 mt-5 -mb-5 border-t border-dark-4 bg-dark-8 px-5 py-3 xl:sticky xl:-bottom-5 xl:z-10"
  >
    <TicketReply
      ticketId={row.id}
      currentStatus={row.status}
      {canReply}
      ondone={done}
      bind:submitting={replying}
      locked={changingStatus}
    />
  </section>
{/snippet}

<!-- Cards render from the row until the detail read arrives, then from the read. -->
{#snippet info()}
  {#if read}
    {@render cards(
      read.payload.ticket.civitaiUserId,
      read.payload.ticket.requesterName || row.requesterName,
      read.payload.ticket.requesterEmail,
      tagSplit?.tier ?? null,
      read.payload
    )}
  {:else}
    {@render cards(row.civitaiUserId, row.requesterName, undefined, undefined, {})}
  {/if}
  {#if view === 'moderation'}
    <TriageCard title="Send to support" dense>
      <p class="m-0 mb-2 text-dark-2">
        Not a moderation issue, or needs the support team? Send it to support.
      </p>
      <TicketEscalate ticketId={row.id} {canEscalate} ondone={done} />
    </TriageCard>
  {/if}
{/snippet}

{#snippet cards(
  civitaiUserId: number | null,
  requesterName: string | null,
  requesterEmail: string | null | undefined,
  tier: string | null | undefined,
  panels: Partial<PanelSections>
)}
  <TriageCard title="Requester" dense>
    <dl class="m-0 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1">
      <dt class="text-dark-2">Name</dt>
      <dd class="m-0 min-w-0 break-words text-white">{requesterLabel({ requesterName, civitaiUserId })}</dd>
      <!-- Read live with the ticket, never from the list or a cache; only for a viewer with the PII grant. -->
      {#if requesterEmail !== undefined}
        <dt class="text-dark-2">Email</dt>
        <dd class="m-0 min-w-0 break-all text-white">{requesterEmail ?? '—'}</dd>
      {/if}
      <dt class="text-dark-2">Account</dt>
      <dd class="m-0">
        {#if civitaiUserId}
          <a class={LINK_CLASS} href={userLookupUrl(civitaiUserId, 'basic')}>User #{civitaiUserId}</a>
        {:else}
          <span class="text-dark-2">No linked Civitai account</span>
        {/if}
      </dd>
      <!-- Tags arrive with the detail read; until then the tier is unknown, not absent. -->
      {#if tier !== undefined}
        <dt class="text-dark-2">Tier</dt>
        <dd class="m-0 min-w-0 break-words text-white">{tier ?? '—'}</dd>
      {/if}
    </dl>
  </TriageCard>
  {#if panels.account}
    <TicketAccount ticketId={row.id} account={panels.account} canAct={canAccountAct} {canUnban} ondone={accountDone} />
  {/if}
  {#if panels.supportAccount}
    <TicketAccount
      ticketId={row.id}
      account={panels.supportAccount}
      canAct={false}
      canUnban={false}
      readOnly
      ondone={accountDone}
    />
  {/if}
  {#if panels.appeals}
    <TicketAppeals
      ticketId={row.id}
      appeals={panels.appeals}
      accountCardShown={panels.account?.status === 'ok'}
      ondone={accountDone}
    />
  {/if}
  {#if panels.ratingDisputes}
    <TicketRatingDisputes ticketId={row.id} disputes={panels.ratingDisputes} ondone={accountDone} />
  {/if}
  {#if panels.history}
    <TicketHistory history={panels.history} />
  {/if}
  {#if panels.contentIssue}
    <TicketContentReports content={panels.contentIssue} />
  {/if}
  {#if panels.generator}
    <TicketGeneratorRestrictions ticketId={row.id} generator={panels.generator} ondone={accountDone} />
  {/if}
  {#if panels.lora}
    <TicketLoraRuns ticketId={row.id} lora={panels.lora} ondone={accountDone} />
  {/if}
{/snippet}

<!-- Below `xl` the columns stack and the pane scrolls as one. The reply sits in the middle column, under the conversation; the sidebar holds only the context cards. -->
<div class="flex min-h-0 flex-1 flex-col overflow-y-auto xl:overflow-hidden">
  <ReportDetailColumns {header} {evidence} actions={info} />
</div>
