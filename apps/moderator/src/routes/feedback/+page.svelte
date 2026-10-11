<script lang="ts">
  import { goto } from '$app/navigation';
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
  import { feedbackOpenHref, feedbackReportHref } from '$lib/feedback-open';
  import { FEEDBACK_ROW_INTERACTIVE, feedbackRowExpands } from '$lib/feedback-row-click';
  import { feedbackNextPageHref } from '$lib/feedback-sort';
  import {
    feedbackAreaLabel,
    feedbackAttachmentCount,
    feedbackStatusBadgeClass,
    handledByLabel,
    isFeedbackStatus,
    splitContext,
  } from '$lib/feedback';
  import {
    FEEDBACK_BULK_SCOPE,
    feedbackRefusalTarget,
    type FeedbackBulkRow,
  } from '$lib/feedback-bulk';
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

  /**
   * Whether the open panel holds unsaved issue-draft text, reported up by `FeedbackDetail`.
   *
   * 🔴 IT SURVIVES THE PANEL THAT SET IT, which is why every read pairs it with `data.openVisible`.
   * `FeedbackDetail` writes this while mounted and cannot write `false` on the way out — a dirty
   * panel the operator then closed would otherwise go on refusing every row click in the queue, with
   * nothing on screen to explain it.
   */
  let panelDirty = $state(false);

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

  /** The condition the bar renders on, named once so the refusal routing can read the same fact. */
  const barMounted = $derived(canSetStatus && selectedRows.length > 0);

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
   * Read by `feedbackRefusalTarget` as `isBulkFailure`, and rendered by `orphanedBulkFailure` when
   * the bar is gone. The bar holds and renders its own refusal through `FormState`; the server
   * stamps the scope because three actions share one page-level `form` object, and a bulk refusal
   * has to be told apart from the two the detail panel owns.
   */
  const bulkFailure = $derived(
    form && 'scope' in form && form.scope === FEEDBACK_BULK_SCOPE && 'error' in form && form.error
      ? String(form.error)
      : null
  );

  /**
   * 🔴 ONE ANSWER — WHICH REMOVES THE AMBIGUITY, NOT THE OBLIGATION. Two surfaces still can render
   * the same refusal if either consumer below stops comparing against its exact literal; the
   * `{#if}` chain only covers the three PAGE-LEVEL arms, and `FeedbackBulkBar`/`FeedbackDetail` are
   * outside it. Read `feedbackRefusalTarget`'s docstring — it carries both measured loosenings —
   * before changing either comparison. This page has double-rendered a refusal three times, and no
   * instance was visible to any test, because this app has no browser tier.
   */
  const refusalTarget = $derived(
    feedbackRefusalTarget({
      hasError: !!(form && 'error' in form && form.error),
      barMounted,
      isBulkFailure: !!bulkFailure,
      rowOpen: data.openVisible,
    })
  );

  /**
   * A BULK refusal with the bar gone — its `FormState` died with the component, so nothing else
   * would show it. Reached when the selection clears mid-flight, or the operator unticks the last
   * row. (The bar's own Clear button is disabled during submit; the checkboxes are not, and
   * disabling the whole table mid-flight would be the worse trade.)
   */
  const orphanedBulkFailure = $derived(refusalTarget === 'orphan' ? bulkFailure : null);

  const bulkMessage = $derived(
    form && 'bulkMessage' in form && form.bulkMessage ? String(form.bulkMessage) : null
  );

  /**
   * 🔴 ONE SPELLING OF `?open=`, and `feedbackOpenHref` is it. The queue's filters, sort and cursor
   * all ride the same query string, so a hand-rolled `new URL(...)` here is how one of them gets
   * dropped on a click whose only job is to expand a row.
   */
  const rowHref = (id: number) => feedbackOpenHref(page.url, data.open === id ? null : id);

  /**
   * 🔴 PROGRESSIVE ENHANCEMENT OVER THE `Open`/`Close` ANCHOR, NEVER A REPLACEMENT FOR IT. That
   * anchor is the no-JS surface AND the keyboard affordance: it is the one thing that makes the
   * panel and its forms reachable for a client that never ran a handler, and it is already in the
   * tab order. Nothing here adds a `tabindex` to the `<tr>` — a second tab stop per row that opened
   * the same panel would make keyboard traversal of a 50-row queue twice as long for no new
   * capability.
   *
   * The decision itself is `feedbackRowExpands`, a pure function, because this app has no Svelte
   * test tier and a guard written inline here is a guard nothing can assert. What stays here is the
   * single DOM read it cannot do: which control, if any, the click landed on.
   *
   * 🔴 `feedbackOpenHref(…, id)`, NOT `rowHref(id)` — this handler OPENS, it never toggles. Closing
   * stays on the labelled anchor.
   *
   * 🔴 THE TWO FACTS THIS PAGE COMPUTES FOR THE PREDICATE, and they answer different questions.
   * `openPanelDirty` is whether expanding would LOSE anything: a row expands by unmounting whatever
   * panel is open (`?open=` is single-valued), so what matters is not that a panel is open but that
   * it holds unsaved text. `panelDirty` is that answer lifted out of `FeedbackDetail`, and
   * `data.openVisible` is what makes it meaningful, since the flag keeps its last value after that
   * component is gone. `alreadyOpen` is whether there is anything to DO — this row's panel is
   * already showing, and the handler never toggles, so the navigation would only push a duplicate
   * history entry. Everything else the predicate declines on is read straight off the event.
   * `feedbackRowExpands` carries the full ordering and the cost.
   *
   * 🔴 `noScroll`/`keepFocus` MIRROR THE ANCHOR'S OWN `data-sveltekit-*` ATTRIBUTES, and the two
   * have to be changed together — `rowHref` only makes the URLs agree, the navigation options are
   * set independently on each side.
   */
  function rowClick(event: MouseEvent, id: number) {
    const target = event.target;
    if (
      !feedbackRowExpands({
        button: event.button,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        defaultPrevented: event.defaultPrevented,
        interactive: target instanceof Element && !!target.closest(FEEDBACK_ROW_INTERACTIVE),
        selection: window.getSelection()?.toString() ?? '',
        openPanelDirty: data.openVisible && panelDirty,
        alreadyOpen: data.open === id,
      })
    )
      return;

    goto(feedbackOpenHref(page.url, id), { noScroll: true, keepFocus: true });
  }

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
   * own message — one banner above every section, in `FeedbackDetail.svelte`. The two surfaces
   * cover disjoint paths; neither is redundant.
   *
   * The other half of "unreachable", which that paragraph left implicit: a LATER navigation could
   * flip `openVisible` to false while a refusal is still in `form`. It cannot, because SvelteKit
   * nulls `form` on navigation and leaves it alone only on invalidation (`client.js:1380-1381`,
   * `form: invalidating ? undefined : null`) — and invalidation here happens only after a SUCCESS,
   * whose `form` carries no `error` key for the guard above to find.
   */
  const pageError = $derived(
    refusalTarget === 'page' && form && 'error' in form && form.error ? String(form.error) : null
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

  <!--
    🔴 ONE CHAIN, SO THESE THREE ARE MUTUALLY EXCLUSIVE WHATEVER THEIR CONDITIONS COMPARE — and
    that is ALL it buys. `FeedbackBulkBar` and `FeedbackDetail` render their own `FormState` errors
    and are NOT in this chain, so exclusion against them still rests on `refusalTarget` being
    compared against `'page'` and `'orphan'` exactly; `feedbackRefusalTarget`'s docstring carries
    the measured loosening that re-opens the 403.

    What two independent `{#if}` blocks could not promise, and did not: the filter hint used to
    render above the table while an orphaned bulk refusal rendered below it — two DIFFERENT
    messages at once, not one refusal twice.

    The hint is last for the reason it always was: "change the filters" is the wrong advice when
    there is a refusal to show, and `refusalTarget === 'none'` is what says there is not.
  -->
  {#if pageError}
    <ErrorAlert message={pageError} class="mb-4" />
  {:else if orphanedBulkFailure}
    <!-- Above the table, not after the pager where this used to sit — beside the other page-level
         refusal rather than a screen away from it.
         ⚠️ A LATERAL TRADE, NOT A FIX: an operator scrolled down to the rows they selected has the
         top of the table off screen too, so this is better for a reader near the top and worse for
         one near the bottom. Reaching them wherever they are needs scroll-into-view or a sticky
         region — a design change, not a move. The bar-gone gap is narrowed, not closed. -->
    <ErrorAlert message={orphanedBulkFailure} class="mb-4" />
  {:else if refusalTarget === 'none' && data.open !== null && !data.openVisible}
    <!-- 🔴 THE LINK IS THE ANSWER, changing the filters IS THE WORKAROUND. `?open=` resolves against
         the rows this view holds, so it can name a report the queue genuinely cannot show;
         `/feedback/<id>` resolves whatever the filters say. Offer the thing that works first.
         Not "clear the filters": with no area picked the view leaves out
         `FEEDBACK_AREAS_EXCLUDED_BY_DEFAULT`, so for an app-feedback report clearing them can never
         bring it into view, and this page does not load the missing row's area to say which. -->
    <p class="mb-4 text-sm text-dark-2">
      Report #{data.open} is not in this view —
      <a href={feedbackReportHref(data.open)} class={LINK_CLASS}>open it on its own page</a>, or
      change the filters to include it.
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
          <TableRow class="cursor-pointer" onclick={(event) => rowClick(event, row.id)}>
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
            <TableCell><Badge variant="outline">{feedbackAreaLabel(row.area)}</Badge></TableCell>
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
              <!-- 🔴 `aria-label` NAMES THE REPORT. Fifty links whose accessible name is the bare
                   word "Open" are fifty identical entries in a screen reader's links list, and
                   `aria-expanded` announces the state without ever saying of what. The visible word
                   stays inside the label so voice control still matches what is on screen.

                   🔴 THE THREE NAVIGATION MODIFIERS, matching `FeedbackSortHeader` and `rowClick`'s
                   `goto` options — without `noscroll` expanding a row scrolls the queue back to the
                   top, away from the row that just opened; without `keepfocus` a keyboard operator
                   who pressed Enter here is dropped to the top of the document and has to tab back
                   past every preceding row to reach the panel they just opened. `replacestate` is
                   deliberately absent: unlike a sort cycle, closing a row with Back is worth a
                   history entry. -->
              <a
                href={rowHref(row.id)}
                class={LINK_CLASS}
                aria-expanded={open}
                aria-label={`${open ? 'Close' : 'Open'} report #${row.id}`}
                data-sveltekit-noscroll
                data-sveltekit-keepfocus
              >
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
                  bind:draftDirty={panelDirty}
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

  {#if barMounted}
    <FeedbackBulkBar rows={selectedRows} onclear={() => selected.clear()} />
  {/if}
{/if}
