<script
  lang="ts"
  generics="T extends { id: number; content: string; createdAt: Date | string; tosViolation: boolean | null }"
>
  import type { Snippet } from 'svelte';
  import { enhance } from '$app/forms';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Checkbox } from '@civitai/ui/components/ui/checkbox/index.js';
  import { Label } from '@civitai/ui/components/ui/label/index.js';
  import { SelectionCheckbox } from '@civitai/ui/components/selection/index.js';
  import { SelectionSet } from '@civitai/ui/hooks/selection-set.svelte.js';
  import { SvelteMap } from 'svelte/reactivity';
  import { FormState } from '$lib/form-state.svelte';
  import { dateTime, num, plainText } from '$lib/format';
  import { postedIds } from './posted-ids';
  import ListCard from './ListCard.svelte';
  import ListFilterBar, { type FilterField } from '$lib/components/ListFilterBar.svelte';
  import ConfirmSubmit from '$lib/components/ConfirmSubmit.svelte';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';
  import SelectionBar from '$lib/components/SelectionBar.svelte';

  let {
    title,
    rows,
    total,
    userId,
    canBulkAct,
    link,
    footer,
    loading = false,
    onDeleted,
  }: {
    title: string;
    /** One page. */
    rows: T[];
    /** Every live comment on the account, not just this page. */
    total: number;
    userId: number;
    canBulkAct: boolean;
    link: Snippet<[T]>;
    footer?: Snippet;
    /** A page turn is in flight: the rows shown are the previous page's. */
    loading?: boolean;
    onDeleted?: () => void;
  } = $props();

  // Matched against the PLAIN text, not the stored HTML — searching the markup meant "p" hit every row.
  const SEARCH: FilterField[] = [{ kind: 'search', key: 'q', label: 'Search content' }];
  let filters = $state<Record<string, string>>({});

  // Deleted rows drop at once, ahead of the refetch `onDeleted` triggers. Flagged
  // ones stay: "Remove as ToS" sets a flag, and a row that vanished would leave the moderator unable
  // to see either the comment or that the flag landed.
  let removed = $state<number[]>([]);
  // This session's ToS outcome per comment, over the fetched `tosViolation`: a ToS action does not
  // refetch the page, and a later refetch reads the replica, which can lag.
  const tosAfterAction = new SvelteMap<number, boolean>();
  const flaggedNow = (c: T) => tosAfterAction.get(c.id) ?? !!c.tosViolation;
  // Outlives a page turn: the panel keeps this mounted while paging.
  const selected = new SelectionSet<number>();
  let partial = $state<string | null>(null);

  const uid = $props.id();
  const live = $derived(rows.filter((r) => !removed.includes(r.id)));
  const shown = $derived(
    filters.q
      ? live.filter((r) => plainText(r.content).toLowerCase().includes(filters.q.toLowerCase()))
      : live
  );
  const shownIds = $derived(shown.map((r) => r.id));
  // Every tick, not `postedIds`' on-screen narrowing: ticks on other pages must post too.
  const posting = $derived([...selected].filter((id) => !removed.includes(id)));
  const onScreen = $derived(postedIds(shown, selected).length);
  const allSelected = $derived(shown.length > 0 && onScreen === shown.length);

  // What was posted, captured at SUBMIT. `posting` is derived from the filter, and the search box has
  // no debounce, so reading it in `onSuccess` returns whatever the operator has typed since — type
  // during a delete and the panel marks nothing while the server deletes everything.
  let acted: number[] = [];
  const form = new FormState({
    onSubmit: () => (acted = posting),
    onSuccess: (data) => {
      const affected = typeof data?.affected === 'number' ? data.affected : acted.length;
      selected.clear();
      // A short count means some ids did not take, and the endpoints report how many rather than which.
      // Marking all of them would fabricate the difference: on a delete, rows that still exist vanish;
      // on a ToS op, comments that were never flagged wear the badge. Mark nothing, say so, reload.
      if (affected < acted.length) {
        partial = `${affected} of ${acted.length} went through — reload to see which.`;
        return;
      }
      partial = null;
      if (data?.op === 'delete') {
        removed = [...removed, ...acted];
        onDeleted?.();
      } else for (const id of acted) tosAfterAction.set(id, data?.op === 'tos');
    },
  });

  const toggleAll = () => {
    // Read once: `allSelected` re-derives after the first delete, which would flip the rest to add.
    const deselect = allSelected;
    for (const id of shownIds) {
      if (deselect) selected.delete(id);
      else selected.add(id);
    }
  };
</script>

<div class="transition-opacity" class:opacity-50={loading} aria-busy={loading}>
  <ListCard
    {title}
    total={shown.length}
    shown={shown.length}
    hint="{num(total)} in all, newest first."
    {footer}
    empty={filters.q
      ? 'No comments match that search.'
      : removed.length
        ? 'Every comment here has been actioned.'
        : 'No comments.'}
  >
    {#snippet controls()}
      <ListFilterBar
        fields={SEARCH}
        bind:values={filters}
        matched={shown.length}
        total={live.length}
      />
      {#if canBulkAct}
        <div class="mb-3 flex items-center gap-2" data-touch-target>
          <!-- Function binding, not a one-way `checked`: the primitive writes to its own `$bindable`
               on click, and a plain prop leaves the box showing the opposite of the selection whenever
               the parent expression does not change. -->
          <Checkbox
            id="all-{uid}"
            bind:checked={() => allSelected, () => toggleAll()}
            bind:indeterminate={() => onScreen > 0 && !allSelected, () => {}}
            disabled={shown.length === 0}
          />
          <Label for="all-{uid}" class="text-xs font-normal text-dark-2">
            Select all {shown.length} shown
          </Label>
        </div>
      {/if}
      {#if partial}
        <p class="mb-3 text-xs text-amber-300">{partial}</p>
      {/if}
    {/snippet}

    {#snippet children(limit)}
      <ul class="space-y-2 text-sm">
        {#each shown.slice(0, limit) as c (c.id)}
          <li>
            <div class="flex flex-wrap items-center gap-x-2" data-touch-target>
              {#if canBulkAct}
                <SelectionCheckbox
                  selection={selected}
                  key={c.id}
                  order={shownIds}
                  aria-label="Select comment {c.id}"
                />
              {/if}
              {@render link(c)}
              {#if flaggedNow(c)}<Badge variant="destructive">ToS</Badge>{/if}
              <span class="text-xs text-dark-2">{dateTime(c.createdAt)}</span>
            </div>
            <p class="line-clamp-2 text-dark-1">{plainText(c.content)}</p>
          </li>
        {/each}
      </ul>
    {/snippet}
  </ListCard>
</div>

<!-- Outside the card: ListCard drops its children when this page is empty, but ticks on other pages
     must stay actionable. -->
{#if canBulkAct}
  <form method="POST" action="?/contentAction" use:enhance={form.enhance}>
    <input type="hidden" name="userId" value={userId} />
    <input type="hidden" name="kind" value="comments" />
    {#each posting as id (id)}
      <input type="hidden" name="commentIds" value={id} />
    {/each}
    <SelectionBar
      count={posting.length}
      onclear={() => selected.clear()}
      clearDisabled={form.submitting}
    >
      {#snippet summary()}
        <span class="text-sm font-semibold text-white">{num(posting.length)} selected</span>
        {#if posting.length > onScreen}
          <span class="text-sm text-amber-300">· {num(posting.length - onScreen)} not shown</span>
        {/if}
      {/snippet}
      {#snippet actions()}
        <div class="ml-auto flex flex-wrap gap-2">
          <ConfirmSubmit
            label="Delete"
            name="op"
            value="delete"
            count={posting.length}
            noun="comment"
            submitting={form.submitting}
            tip="Delete every selected comment, including any not on this page."
          />
          <ConfirmSubmit
            label="Remove as ToS"
            name="op"
            value="tos"
            count={posting.length}
            noun="comment"
            submitting={form.submitting}
            tip="Flag every selected comment as a ToS violation: it is hidden, its reports are actioned and the owner is notified."
          />
          <!-- Setting the flag used to be a one-way door: nothing in either app cleared it, and a ban
               purge can set it across a whole account in one click. This is the way back, and it also
               reopens the reports the flag actioned. -->
          <ConfirmSubmit
            label="Restore from ToS"
            name="op"
            value="untos"
            count={posting.length}
            noun="comment"
            submitting={form.submitting}
            tip="Clear the ToS flag and reopen the reports it closed. Buzz already paid to reporters stays paid, and the owner is not notified."
          />
        </div>
      {/snippet}
      {#if form.error}
        <ErrorAlert message={form.error} />
      {/if}
    </SelectionBar>
  </form>
{/if}
