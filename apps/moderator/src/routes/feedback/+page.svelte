<script lang="ts">
  import { page } from '$app/state';
  import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
  } from '@civitai/ui/components/ui/table/index.js';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Checkbox } from '@civitai/ui/components/ui/checkbox/index.js';
  import { SelectionCheckbox } from '@civitai/ui/components/selection/index.js';
  import { SelectionSet } from '@civitai/ui/hooks/selection-set.svelte.js';
  import CursorPager from '$lib/components/CursorPager.svelte';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';
  import { LINK_CLASS, dateTime, shortAge } from '$lib/format';
  import { issuesUrl, userLookupUrl } from '$lib/entity-url';
  import { feedbackOpenHref } from '$lib/feedback-tabs';
  import { feedbackNextPageHref } from '$lib/feedback-sort';
  import {
    feedbackAttachmentCount,
    feedbackStatusBadgeClass,
    handledByLabel,
    isFeedbackStatus,
    splitContext,
  } from '$lib/feedback';
  import { FEEDBACK_BULK_SCOPE, type FeedbackBulkRow } from '$lib/feedback-bulk';
  import FeedbackFilters from './FeedbackFilters.svelte';
  import FeedbackDetail from './FeedbackDetail.svelte';
  import FeedbackBulkBar from './FeedbackBulkBar.svelte';
  import FeedbackSortHeader, { type FeedbackColumn } from './FeedbackSortHeader.svelte';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  /**
   * One grant, ONE spelling. It gates the single-row triage form and the selection bar alike, and
   * two `!!data.grants[...]` expressions on one page is how they drift apart.
   */
  const canSetStatus = $derived(!!data.grants['feedback.status.set']);

  const selected = new SelectionSet<number>();

  /**
   * 🔴 THE SELECTION IS CLEARED WHENEVER THE LIST CHANGES, AND THAT IS A CORRECTNESS GUARD RATHER
   * THAN TIDINESS. Every id in it is paired with the status that row was SHOWING, and the pair is
   * what the server's per-row concurrency check compares against — so a selection surviving a page
   * turn, a filter change or a post-triage reload would post expectations read off rows that are no
   * longer on screen. Same shape as `images/to-ingest`.
   *
   * `$effect` and not `$derived`: this synchronises a local mirror with a prop, which is the case
   * the standard leaves to `$effect` rather than the data-fetching one it forbids.
   */
  $effect(() => {
    data.items;
    selected.clear();
  });

  /**
   * Only rows whose status this page can express a transition FROM.
   *
   * ⚠️ THE RUNTIME BRANCH IS UNREACHABLE TODAY, AND THE EARLIER VERSION OF THIS COMMENT WAS WRONG
   * TO IMPLY OTHERWISE. It claimed a status outside `FEEDBACK_STATUSES` "is representable";
   * measured against production 2026-09-15, `Feedback_status_check` is
   * `CHECK (status = ANY (ARRAY['new','reviewed','actioned','dismissed']))` — exactly this
   * constant — so Postgres already enforces the property and no such row can exist. Do not read the
   * filter below as a live hazard.
   *
   * 🔴 IT STAYS FOR A DIFFERENT AND SMALLER REASON: `FeedbackRow.status` is typed `string`, so this
   * predicate is the only thing that narrows it to `FeedbackStatus` for `expectedStatus`. The
   * runtime effect is a second-order defence against the CHECK being widened without this constant
   * following — in which case the bar simply omits the checkbox, rather than encoding a pair the
   * server's parser refuses, which would block the whole submission over one row.
   */
  const selectableIds = $derived(
    data.items.filter((row) => isFeedbackStatus(row.status)).map((row) => row.id)
  );

  /** The selected rows as the queue currently shows them — id plus the on-screen status. */
  // `flatMap` rather than `filter().map()`: the status guard is a type predicate, and it only
  // narrows `row.status` inside the branch that tested it — across a `.filter()` boundary the
  // element type is unchanged and `expectedStatus` would be a bare `string`.
  const selectedRows = $derived(
    data.items.flatMap((row): FeedbackBulkRow[] =>
      selected.has(row.id) && isFeedbackStatus(row.status)
        ? [{ id: row.id, expectedStatus: row.status }]
        : []
    )
  );

  const allSelected = $derived(
    selectableIds.length > 0 && selectableIds.every((id) => selected.has(id))
  );
  const someSelected = $derived(selectedRows.length > 0 && !allSelected);

  function toggleAll() {
    if (allSelected) selected.clear();
    else for (const id of selectableIds) selected.add(id);
  }

  /**
   * Whether the last refusal belongs to the selection bar.
   *
   * 🔴 ONLY used to keep `pageError` from rendering it a SECOND time — the bar holds and renders its
   * own refusal through `FormState`, which is what removes the routing question rather than
   * answering it per panel. The server stamps the scope because three actions share one page-level
   * `form` object.
   */
  const bulkFailure = $derived(
    form && 'scope' in form && form.scope === FEEDBACK_BULK_SCOPE && 'error' in form && form.error
      ? String(form.error)
      : null
  );

  /**
   * 🔴 THE BAR IS NOT ALWAYS THERE TO SHOW ITS OWN REFUSAL, AND WITHOUT THIS THE REFUSAL IS SILENT.
   * `FeedbackBulkBar` renders only while something is selected, and its `FormState` — which holds
   * the error — is destroyed with it. An operator who unticks the last row while a submit is in
   * flight gets the failure back into a component that no longer exists. (Its own Clear button is
   * disabled during submit; the checkboxes are not, and disabling the whole table mid-flight would
   * be a worse trade than rendering the message here.)
   */
  const orphanedBulkFailure = $derived(selectedRows.length === 0 ? bulkFailure : null);

  const bulkMessage = $derived(
    form && 'bulkMessage' in form && form.bulkMessage ? String(form.bulkMessage) : null
  );

  /**
   * 🔴 `feedbackOpenHref`, NOT a bare `urlWith({ open })` — it also DELETES `?tab=`, and that
   * deletion is the whole reason the helper exists (its docstring carries the repro). Opening a row
   * is the one navigation that changes WHICH report is on screen, so it is the one that must not
   * inherit the tab chosen for the previous one.
   */
  const rowHref = (id: number) => feedbackOpenHref(page.url, data.open === id ? null : id);

  /**
   * 🔴 THE NO-JS SURFACE, and only that. Deleting it as dead code is the mistake to avoid.
   *
   * Without JS the browser posts a full page load to `/feedback?/triage`, so `load` re-runs against
   * a URL carrying no `?open=`: no panel is rendered, and this is the only thing that tells the
   * operator their triage was refused.
   *
   * With JS it is unreachable, and the `openVisible` gate is what makes that true. `update()`
   * re-runs `load` ONLY on success (`@sveltejs/kit@2.66.0`, `runtime/app/forms.js:99-107` — both
   * the reset and `invalidateAll()` sit inside `if (result.type === 'success')`), so a refusal
   * leaves `data` untouched, the row open, `openVisible` true, and the panel mounted to render its
   * own message — which since the tab strip landed is a single banner ABOVE that strip, in
   * `FeedbackDetail.svelte`, rather than one inside each form's own section. The two surfaces still
   * cover disjoint paths; neither is redundant.
   *
   * The other half of "unreachable", which that paragraph left implicit: a LATER navigation could
   * flip `openVisible` to false while a refusal is still in `form`. It cannot, because SvelteKit
   * nulls `form` on navigation and leaves it alone only on invalidation (`client.js:1380-1381`,
   * `form: invalidating ? undefined : null`) — and invalidation here happens only after a SUCCESS,
   * whose `form` carries no `error` key for the guard above to find.
   *
   * 🔴 The tab triggers are LINKS for this same reason (`FeedbackTabs.svelte`): a no-JS client must
   * still be able to reach `?tab=triage`, or the form this message is about would be unreachable.
   */
  // 🔴 `!bulkFailure` is part of the condition: the bulk action's refusal is rendered by the selection
  // bar, which is `fixed` and therefore always in view. Without this clause a bulk refusal raised
  // with no row open would render TWICE — once here and once in the bar.
  const pageError = $derived(
    !data.openVisible && !bulkFailure && form && 'error' in form && form.error
      ? String(form.error)
      : null
  );

  const nextPageHref = $derived(
    data.nextCursor === null
      ? null
      : feedbackNextPageHref(page.url, data.nextCursor, data.nextCursorValue)
  );

  // 🔴 `COLUMNS.length` is what every `colspan` below reads — adding a row here without that is how
  // the detail panel and the empty state end up a cell short.
  //
  // 🔴 IT IS `$derived` BECAUSE THE SELECT COLUMN IS CONDITIONAL, and that is precisely why the
  // select column belongs IN this list rather than being rendered beside it. A checkbox cell emitted
  // outside `COLUMNS` would make the real width `COLUMNS.length + 1` for anyone holding the grant,
  // and the detail panel and empty-state rows would be one cell short for them and correct for
  // everyone else — a defect only a moderator with the grant could see.
  const COLUMNS: FeedbackColumn[] = $derived([
    ...(canSetStatus
      ? [{ id: 'select', label: '', sortable: null, class: 'w-px' } satisfies FeedbackColumn]
      : []),
    { id: 'age', label: 'Age', sortable: 'age' },
    { id: 'area', label: 'Area', sortable: 'area' },
    { id: 'user', label: 'User', sortable: 'user' },
    { id: 'message', label: 'Message', sortable: null },
    // Not sortable — a SQL ordering would need a second implementation of the attachment count;
    // `$lib/feedback-sort.ts` has the reasoning.
    { id: 'attachments', label: '📎', sortable: null, class: 'text-right' },
    { id: 'status', label: 'Status', sortable: 'status' },
    { id: 'handled', label: 'Handled', sortable: 'handled' },
    { id: 'issue', label: 'Issue', sortable: 'issue' },
    { id: 'actions', label: '', sortable: null, class: 'w-px' },
  ]);
</script>

<header class="page-header">
  <h1>Feedback</h1>
  <p>
    <!-- "by default": the ordering is a column sort now, so an unconditional "newest first" is a
         claim this page stops supporting the moment an operator clicks a header. -->
    In-product reports from the site's feedback prompts, newest first by default. Everything under
    <strong>Context</strong> is what the reporter's browser said — a claim, not evidence.
  </p>
</header>

{#if data.migrationPending}
  <!-- 🔴 `moderator:admin` reaches this page before anyone ticks a box on `/admin`, and the sidebar
       badge counts on `status` alone — so it renders a real number against a database that has not
       had the triage columns applied. Says what to do instead of throwing out of `load`.
       This names ONE migration, so `isMissingTriageColumns` is keyed on that migration's own column
       names: any other absent column still throws rather than arriving here as wrong advice. -->
  <div class="rounded-xl border border-dark-4 bg-dark-6 p-5">
    <p class="text-white">This queue is not ready yet.</p>
    <p class="mt-2 text-sm text-dark-2">
      Its migration has not been applied to this database. Migrations here are run by hand, per
      environment — apply <code>20260911120000_feedback_triage</code> and reload. The sidebar count
      reads a column that already exists, which is why it still shows a number.
    </p>
  </div>
{:else}
  <FeedbackFilters
    statuses={data.statuses}
    area={data.area}
    areaOptions={data.areaOptions}
    shown={data.items.length}
  />

  {#if pageError}
    <ErrorAlert message={pageError} class="mb-4" />
  {:else if data.open !== null && !data.openVisible}
    <!-- Only when there is no refusal to show: "clear the filters" is the wrong advice for a row
         that was just deleted, and that is the case where both would otherwise render. -->
    <p class="mb-4 text-sm text-dark-2">
      Report #{data.open} is not in this view — clear the filters to open it.
    </p>
  {/if}

  <!--
    🔴 NARROW WIDTHS SCROLL, THEY DO NOT COLLAPSE — deliberate, and the operator's call. Nine columns
    do not become a card list; they stay a table and the container scrolls.

    `min-w-0` is the whole guard: this sits in a flex column, where a flex item's default
    `min-width: auto` lets a wide child push the item — and therefore the PAGE — wider than the
    viewport. `@civitai/ui`'s `Table` already wraps in `overflow-x-auto`, so the table scrolls inside
    this box; without `min-w-0` the box itself could grow and the page body would scroll instead,
    which is the one thing that must never happen.

    No ultrawide cap is added HERE on purpose. `+layout.svelte` puts every page that does not ask for
    `wide`/`fullBleed` inside `mx-auto w-full max-w-6xl`, and this page asks for neither — so the cap
    already exists one level up. A second one would be a number in two places that can disagree.
  -->
  <div class="min-w-0 rounded-xl border border-dark-4 bg-dark-6">
    <Table>
      <TableHeader>
        <TableRow>
          {#each COLUMNS as column (column.id)}
            {#if column.id === 'select'}
              <TableHead class={column.class}>
                <!-- 🔴 FUNCTION BINDINGS, NOT `checked=`. bits-ui writes `checked` on interaction,
                     and a plain prop latches on that write — the tri-state case is the one that
                     always latches, because `some → all` leaves `checked` false throughout
                     (docs/svelte-app-standard.md). The `indeterminate` setter ignores its argument
                     on purpose: a primitive resolves a click on an indeterminate box to `true`,
                     which would select rather than toggle. -->
                <Checkbox
                  bind:checked={() => allSelected, toggleAll}
                  bind:indeterminate={() => someSelected, () => {}}
                  disabled={selectableIds.length === 0}
                  aria-label={allSelected ? 'Clear selection' : 'Select every report on this page'}
                />
              </TableHead>
            {:else}
              <FeedbackSortHeader {column} sort={data.sort} />
            {/if}
          {/each}
        </TableRow>
      </TableHeader>
      <TableBody>
        {#each data.items as row (row.id)}
          {@const context = splitContext(row.context)}
          {@const attachments = feedbackAttachmentCount(context)}
          {@const open = data.open === row.id}
          <TableRow>
            {#if canSetStatus}
              <TableCell>
                {#if isFeedbackStatus(row.status)}
                  <!-- `order` is what a shift-click spans: the selectable ids in the order they are
                       on screen, so a range cannot reach a row the operator cannot see. -->
                  <SelectionCheckbox
                    selection={selected}
                    key={row.id}
                    order={selectableIds}
                    aria-label={`Select report #${row.id}`}
                  />
                {:else}
                  <!-- A status this page cannot express a transition from; see `selectableIds`. -->
                  <span class="sr-only">Report #{row.id} cannot be triaged in bulk</span>
                {/if}
              </TableCell>
            {/if}
            <TableCell class="whitespace-nowrap tabular-nums" title={dateTime(row.createdAt)}>
              {shortAge(row.createdAt)}
            </TableCell>
            <TableCell><Badge variant="outline">{row.area}</Badge></TableCell>
            <TableCell>
              {#if row.username}
                <a href={userLookupUrl(row.username)} class={LINK_CLASS}>{row.username}</a>
              {:else}
                <span class="text-dark-2">#{row.userId}</span>
              {/if}
            </TableCell>
            <!-- The only column with a free-text value, so it is the only one whose width drives the
                 table's own. Bounded per breakpoint rather than at a flat `max-w-md`: 28rem of
                 message on a 24rem viewport is most of the horizontal scroll the operator has to do
                 to reach the Status and Open columns. -->
            <TableCell class="max-w-[10rem] sm:max-w-xs lg:max-w-md">
              <span class="line-clamp-1 text-sm text-dark-2" title={row.message}>{row.message}</span>
            </TableCell>
            <TableCell class="text-right tabular-nums text-dark-2">{attachments || ''}</TableCell>
            <TableCell>
              <Badge class={feedbackStatusBadgeClass(row.status)}>{row.status}</Badge>
            </TableCell>
            <TableCell class="whitespace-nowrap text-sm text-dark-2">
              {handledByLabel(row)}
            </TableCell>
            <TableCell class="whitespace-nowrap tabular-nums">
              {#if row.bugId}
                <a
                  href={issuesUrl(data.civitaiUrl)}
                  target="_blank"
                  rel="noreferrer"
                  class={LINK_CLASS}
                >
                  #{row.bugId}
                </a>
              {:else}
                <span class="text-dark-2">—</span>
              {/if}
            </TableCell>
            <TableCell>
              <a href={rowHref(row.id)} class={LINK_CLASS} aria-expanded={open}>
                {open ? 'Close' : 'Open'}
              </a>
            </TableCell>
          </TableRow>
          {#if open}
            <TableRow>
              <!-- `whitespace-normal` undoes `TableCell`'s default `whitespace-nowrap`: the panel
                   holds prose and a JSON dump, and inheriting nowrap would make every long line
                   widen the table rather than wrap inside the panel. -->
              <TableCell colspan={COLUMNS.length} class="bg-dark-7/40 p-0 whitespace-normal">
                <FeedbackDetail
                  {row}
                  {context}
                  siblings={data.siblings}
                  knownIssues={data.knownIssues}
                  grafanaUrl={data.grafanaUrl}
                  civitaiUrl={data.civitaiUrl}
                  canTriage={canSetStatus}
                  canPromote={!!data.grants['feedback.bug.promote']}
                />
              </TableCell>
            </TableRow>
          {/if}
        {:else}
          <TableRow>
            <TableCell colspan={COLUMNS.length} class="py-8 text-center text-dark-2">
              No feedback matches this view.
            </TableCell>
          </TableRow>
        {/each}
      </TableBody>
    </Table>
  </div>

  <CursorPager href={nextPageHref} />

  <!-- Above the bar rather than inside it: the bar unmounts the moment a successful run clears the
       selection, which is exactly when this sentence has something to say. -->
  {#if bulkMessage}
    <!-- `role="status"`: a successful run unmounts the bar, so this line is the only report of what
         happened — and it appears with no focus change to announce it. -->
    <p role="status" class="mt-4 text-sm text-teal-400">{bulkMessage}</p>
  {/if}

  {#if orphanedBulkFailure}
    <ErrorAlert message={orphanedBulkFailure} class="mt-4" />
  {/if}

  {#if canSetStatus && selectedRows.length > 0}
    <FeedbackBulkBar rows={selectedRows} onclear={() => selected.clear()} />
  {/if}
{/if}
