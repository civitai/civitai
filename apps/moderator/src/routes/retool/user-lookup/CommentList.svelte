<script
  lang="ts"
  generics="T extends { id: number; content: string; createdAt: Date | string; tosViolation: boolean | null }"
>
  import type { Snippet } from 'svelte';
  import { enhance } from '$app/forms';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Checkbox } from '@civitai/ui/components/ui/checkbox/index.js';
  import { Label } from '@civitai/ui/components/ui/label/index.js';
  import { FormState } from '$lib/form-state.svelte';
  import { dateTime, plainText } from '$lib/format';
  import ListCard from './ListCard.svelte';
  import ListFilterBar, { type FilterField } from '$lib/components/ListFilterBar.svelte';
  import ConfirmSubmit from '$lib/components/ConfirmSubmit.svelte';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';

  let {
    title,
    rows,
    truncated,
    userId,
    canBulkAct,
    field,
    link,
    badges,
  }: {
    title: string;
    rows: T[];
    truncated: boolean;
    userId: number;
    canBulkAct: boolean;
    field: 'commentIds' | 'commentV2Ids';
    link: Snippet<[T]>;
    badges?: Snippet<[T]>;
  } = $props();

  // Matched against the PLAIN text, not the stored HTML — searching the markup meant "p" hit every row.
  const SEARCH: FilterField[] = [{ kind: 'search', key: 'q', label: 'Search content' }];
  let filters = $state<Record<string, string>>({});

  // Deleted rows drop in place rather than refetching the account payload behind every write. Flagged
  // ones stay: "Remove as ToS" sets a flag, and a row that vanished would leave the moderator unable
  // to see either the comment or that the flag landed.
  let removed = $state<number[]>([]);
  let flagged = $state<number[]>([]);
  let selected = $state<number[]>([]);
  let partial = $state<string | null>(null);

  const uid = $props.id();
  const live = $derived(rows.filter((r) => !removed.includes(r.id)));
  const shown = $derived(
    filters.q
      ? live.filter((r) => plainText(r.content).toLowerCase().includes(filters.q.toLowerCase()))
      : live
  );
  // Only what is on screen posts. A selection made before a search was typed would otherwise still be
  // in the form, and the moderator would confirm a count they cannot see.
  const posting = $derived(selected.filter((id) => shown.some((r) => r.id === id)));
  const allSelected = $derived(shown.length > 0 && posting.length === shown.length);

  // What was posted, captured at SUBMIT. `posting` is derived from the filter, and the search box has
  // no debounce, so reading it in `onSuccess` returns whatever the operator has typed since — type
  // during a delete and the panel marks nothing while the server deletes everything.
  let acted: number[] = [];
  let unflagged = $state<number[]>([]);
  const form = new FormState({
    onSubmit: () => (acted = posting),
    onSuccess: (data) => {
      const affected = typeof data?.affected === 'number' ? data.affected : acted.length;
      selected = [];
      // A short count means some ids did not take, and the endpoints report how many rather than which.
      // Marking all of them would fabricate the difference: on a delete, rows that still exist vanish;
      // on a ToS op, comments that were never flagged wear the badge. Mark nothing, say so, reload.
      if (affected < acted.length) {
        partial = `${affected} of ${acted.length} went through — reload to see which.`;
        return;
      }
      partial = null;
      if (data?.op === 'delete') removed = [...removed, ...acted];
      else if (data?.op === 'untos') {
        // The optimistic mark has to be reversible too: leaving the id in `flagged` keeps the badge on
        // a comment that is back on the page, which is the same class of wrong the restore just fixed.
        unflagged = [...unflagged, ...acted];
        flagged = flagged.filter((id) => !acted.includes(id));
      } else flagged = [...flagged, ...acted];
    },
  });

  const toggleAll = () => (selected = allSelected ? [] : shown.map((r) => r.id));
  const toggle = (id: number) =>
    (selected = selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
</script>

<ListCard
  {title}
  total={shown.length}
  capped={truncated}
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
      <div class="mb-3 flex items-center gap-2">
        <!-- Function binding, not a one-way `checked`: the primitive writes to its own `$bindable`
             on click, and a plain prop leaves the box showing the opposite of the selection whenever
             the parent expression does not change. -->
        <Checkbox
          id="all-{uid}"
          bind:checked={() => allSelected, () => toggleAll()}
          bind:indeterminate={() => posting.length > 0 && !allSelected, () => {}}
          disabled={shown.length === 0}
        />
        <Label for="all-{uid}" class="text-xs font-normal text-dark-2">
          Select all {shown.length} shown — {posting.length} selected
        </Label>
      </div>
    {/if}
    {#if form.error}
      <ErrorAlert class="mb-3" message={form.error} />
    {:else if partial}
      <p class="mb-3 text-xs text-amber-300">{partial}</p>
    {/if}
  {/snippet}

  {#snippet children(limit)}
    <form method="POST" action="?/contentAction" use:enhance={form.enhance}>
      <input type="hidden" name="userId" value={userId} />
      <input type="hidden" name="kind" value="comments" />
      <!-- Posted from the selection rather than from the row checkboxes, so a select-all still acts on
           the rows the card has not expanded to yet. -->
      {#each posting as id (id)}
        <input type="hidden" name={field} value={id} />
      {/each}
      <ul class="space-y-2 text-sm">
        {#each shown.slice(0, limit) as c (c.id)}
          <li>
            <div class="flex flex-wrap items-center gap-x-2">
              {#if canBulkAct}
                <Checkbox
                  bind:checked={() => selected.includes(c.id), () => toggle(c.id)}
                  aria-label="Select comment {c.id}"
                />
              {/if}
              {@render link(c)}
              {@render badges?.(c)}
              {#if flagged.includes(c.id) && !c.tosViolation && !unflagged.includes(c.id)}
                <Badge variant="destructive">ToS</Badge>
              {/if}
              <span class="text-xs text-dark-2">{dateTime(c.createdAt)}</span>
            </div>
            <p class="line-clamp-2 text-dark-1">{plainText(c.content)}</p>
          </li>
        {/each}
      </ul>
      {#if canBulkAct}
        <div class="mt-3 flex flex-wrap gap-2 border-t border-dark-4 pt-3">
          <ConfirmSubmit
            label="Delete"
            name="op"
            value="delete"
            count={posting.length}
            noun="comment"
            submitting={form.submitting}
          />
          <ConfirmSubmit
            label="Remove as ToS"
            name="op"
            value="tos"
            count={posting.length}
            noun="comment"
            submitting={form.submitting}
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
          />
        </div>
      {/if}
    </form>
  {/snippet}
</ListCard>
