<script lang="ts" generics="K extends string | number, R">
  import { afterNavigate, invalidateAll, replaceState } from '$app/navigation';
  import { page } from '$app/state';
  import type { ActionResult, SubmitFunction } from '@sveltejs/kit';
  import { tick, type Snippet } from 'svelte';
  import { SvelteMap } from 'svelte/reactivity';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { cn } from '@civitai/ui/utils.js';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';
  import { LINK_CLASS, num } from '$lib/format';
  import { optimisticEnhancer } from '$lib/form-action';
  import { submitDecisionForm } from '$lib/triage/decision-form';
  import { isDialogOpen, isTypingTarget, triageKeyAction } from '$lib/triage/keys';
  import { reasonPicker } from '$lib/triage/reason-picker.svelte';
  import { failureBanner, failureMessage, nextUndecided, step, type Outcome } from '$lib/triage/queue';
  import { urlWith } from '$lib/url';

  // `subject` is a ready-made label for the item a refusal belongs to; `key` is its queue key.
  type QueueForm = { error?: string; subject?: string; key?: string | number } | null;
  type RowState = {
    id: string;
    selected: boolean;
    verdict: string | undefined;
    error: string | undefined;
    href: string;
    select: () => void;
  };
  type DetailState = {
    verdict: string | undefined;
    error: string | undefined;
    /** The enhancer for one action; `outcome` is what the item shows once it is decided. */
    submit: (outcome: Outcome) => SubmitFunction;
  };

  /**
   * The master-detail triage every queue shares: a list on the left, the open item on the right,
   * J/K to move, digits to rule (a decision with reasons opens its reason list for a second press), and the list dimming decided items in place (offsets shift under
   * paging, so the page is only re-cut on request). The queues supply the rows and what they show;
   * the detail goes on `TriageColumns`. The layout: docs/moderator-app/triage-layout.md.
   */
  let {
    rows,
    rowKey,
    parseKey,
    selectionParam,
    queueLabel,
    itemLabel,
    decisionEnabled,
    settled,
    decisionActions = ['uphold', 'overturn'],
    ondecision,
    pinned = null,
    current = $bindable(null),
    outcomeFor = (_result, outcome) => outcome,
    pageNumber,
    hasMore,
    offset,
    total,
    form,
    listRow,
    listHeader,
    detail,
    empty,
    notice,
    flush = false,
  }: {
    rows: R[];
    rowKey: (row: R) => K;
    /** Reads the selection back out of the URL param. */
    parseKey: (raw: string) => K | null;
    selectionParam: string;
    /** Accessible names for the list and detail regions. */
    queueLabel: string;
    itemLabel: string;
    /** One entry per decision, in key order: digit `n + 1` picks index `n`. False makes that key a no-op. */
    decisionEnabled: (row: R) => readonly boolean[];
    /** A row that needs no decision although this shell did not act on it, so moving on skips it. */
    settled?: (row: R) => boolean;
    /** The `data-triage-action` of the form each decision key submits, in key order. */
    decisionActions?: readonly string[];
    /** Handles a decision key itself instead of submitting that decision's form. */
    ondecision?: (row: R, index: number) => void;
    /** A row that is selectable although it is not on this page (a deep link). */
    pinned?: R | null;
    /** The key of the open item, for a queue that keeps state per item. */
    current?: K | null;
    /** Lets a queue relabel a success, e.g. when the main app reports nothing was left to do. */
    outcomeFor?: (result: ActionResult, outcome: string) => string;
    pageNumber: number;
    hasMore: boolean;
    offset: number;
    total?: number;
    form?: QueueForm | undefined;
    listRow: Snippet<[R, RowState]>;
    /** A compact row above the list: filter chips and sort. */
    listHeader?: Snippet;
    detail: Snippet<[R, DetailState]>;
    empty: Snippet;
    /** `unpicked` is true until the moderator chooses a row, as opposed to defaulting to the first. */
    notice?: Snippet<[{ unpicked: boolean }]>;
    /** Edge to edge under a page header: a fixed-width list flush against the detail pane, no cards
     *  or gutter, and a compact footer. The page places its own notices. */
    flush?: boolean;
  } = $props();

  const keys = $derived(rows.map(rowKey));

  const keyInUrl = () => {
    const raw = page.url.searchParams.get(selectionParam);
    return raw ? parseKey(raw) : null;
  };

  let selectedKey = $state<K | null>(keyInUrl());
  const pinnedKey = $derived(pinned ? rowKey(pinned) : null);
  const selected = $derived(
    rows.find((r) => rowKey(r) === selectedKey) ??
      (pinned && pinnedKey === selectedKey ? pinned : undefined) ??
      rows[0]
  );
  const selectedRowKey = $derived(selected ? rowKey(selected) : null);
  $effect(() => {
    current = selectedRowKey;
  });

  // Optimistic outcomes by key; cleared on reload so a mark can't outlive its item.
  const acted = new SvelteMap<K, string>();
  // A refusal belongs to its item, so a later success elsewhere must not wipe it.
  const errors = new SvelteMap<K, string>();
  $effect(() => {
    void rows;
    acted.clear();
    errors.clear();
  });

  // After a reload the selection may be an item that is gone; null lets the URL mirror follow.
  $effect(() => {
    if (selectedKey !== null && !keys.includes(selectedKey) && selectedKey !== pinnedKey)
      selectedKey = null;
  });

  // Navigation (filters, search, paging, back) rebuilds the selection from the URL it landed on.
  let mirrored = keyInUrl();
  afterNavigate(() => {
    selectedKey = keyInUrl();
    mirrored = selectedKey;
  });

  // `page.url` does not follow a shallow `replaceState`, so the selection is its own state and the
  // address bar only mirrors it. Debounced: a held J/K would otherwise call replaceState per repeat,
  // and Safari throws past 100 calls in 30s.
  const select = (key: K) => (selectedKey = key);
  $effect(() => {
    const key = selectedKey;
    if (key === null || key === mirrored) return;
    const timer = setTimeout(() => {
      replaceState(urlWith(page.url, { [selectionParam]: key }), page.state);
      mirrored = key;
    }, 200);
    return () => clearTimeout(timer);
  });

  const rowId = (key: K) => `triage-${String(key).replace(/[^\w-]/g, '_')}`;

  $effect(() => {
    if (selectedRowKey !== null)
      document.getElementById(rowId(selectedRowKey))?.scrollIntoView({ block: 'nearest' });
  });

  const advance = async (decidedKey: K) => {
    if (selectedRowKey !== decidedKey) return;
    const next = nextUndecided(
      keys,
      decidedKey,
      (key) => acted.has(key) || (settled?.(rows[keys.indexOf(key)]) ?? false)
    );
    if (next === null) return;
    select(next);
    await tick();
    document.querySelector<HTMLElement>(`#${rowId(next)} a`)?.focus({ preventScroll: true });
  };

  const submit = (key: K, outcome: Outcome): SubmitFunction => {
    return async (input) => {
      // Read at submit time, so the label cannot diverge from the decision actually posted.
      const verdict = typeof outcome === 'string' ? outcome : outcome(input.formData);
      const decide = optimisticEnhancer(() => {
        errors.delete(key);
        acted.set(key, verdict);
        return () => acted.delete(key);
      });
      const finish = await decide(input);
      return async (result) => {
        await finish?.(result);
        const message = failureMessage(result.result);
        if (message) {
          errors.set(key, message);
          if (selectedRowKey === key) {
            await tick();
            document
              .querySelector<HTMLElement>('[data-triage-actions] button:not([disabled])')
              ?.focus();
          }
        } else {
          // A reload mid-flight clears the mark; the decision is final, so put it back.
          acted.set(key, outcomeFor(result.result, verdict));
          advance(key);
        }
      };
    };
  };

  function onkeydown(e: KeyboardEvent) {
    const action = triageKeyAction({
      key: e.key,
      ctrlKey: e.ctrlKey,
      metaKey: e.metaKey,
      altKey: e.altKey,
      defaultPrevented: e.defaultPrevented,
      isComposing: e.isComposing,
      typing: isTypingTarget(e.target as Element | null),
      dialogOpen: isDialogOpen(),
      picking: reasonPicker.open !== null,
      decisionEnabled:
        selected && selectedRowKey !== null && !acted.has(selectedRowKey)
          ? decisionEnabled(selected)
          : [],
    });
    if (!action) return;
    e.preventDefault();
    if (action === 'next' || action === 'previous') {
      const to = step(keys, selectedRowKey, action === 'next' ? 1 : -1);
      if (to !== null) select(to);
    } else if (!e.repeat && selected) {
      if (ondecision) ondecision(selected, action.decision);
      else submitDecisionForm(decisionActions, decisionEnabled(selected), action.decision);
    }
  }

  const pageHref = (n: number) => urlWith(page.url, { page: n, [selectionParam]: null });
  // Not inline: `{/` opens a closing tag in a template.
  const selectPrompt = $derived(
    `Select ${/^[aeiou]/i.test(itemLabel) ? 'an' : 'a'} ${itemLabel.toLowerCase()} from the queue.`
  );
  const banner = $derived(
    form?.error && !form.subject && form.key !== undefined
      ? `${itemLabel} #${form.key}: ${form.error}`
      : failureBanner(form)
  );
  const firstShown = $derived(offset + 1);
  const lastShown = $derived(offset + rows.length);
</script>

<svelte:window {onkeydown} />

{#if banner && errors.size === 0}
  <ErrorAlert class={flush ? 'mx-6 mt-3' : ''} message={banner} />
{/if}
{@render notice?.({ unpicked: selectedKey === null })}

<div class={cn('flex min-h-0 flex-1 flex-col lg:flex-row', !flush && 'gap-4')}>
  <aside
    aria-label={queueLabel}
    class={cn(
      'flex max-h-80 min-h-0 flex-col overflow-hidden lg:max-h-none lg:shrink-0',
      flush
        ? 'border-b border-dark-4 bg-dark-7 lg:w-[400px] lg:border-r lg:border-b-0'
        : 'rounded-xl border border-dark-4 bg-dark-6 lg:w-[35%] lg:max-w-[36rem] lg:min-w-80'
    )}
  >
    {#if listHeader}
      <div class={cn('shrink-0 border-b border-dark-4 px-3', flush ? 'py-2.5' : 'py-2')}>
        {@render listHeader()}
      </div>
    {/if}
    <div class="min-h-0 flex-1 overflow-y-auto">
      {#if rows.length}
        <ul class={cn('m-0 list-none p-0', !flush && 'divide-y divide-dark-4')}>
          {#each rows as row (rowKey(row))}
            {@const key = rowKey(row)}
            {@render listRow(row, {
              id: rowId(key),
              selected: key === selectedRowKey,
              verdict: acted.get(key),
              error: errors.get(key),
              href: urlWith(page.url, { [selectionParam]: key }),
              select: () => select(key),
            })}
          {/each}
        </ul>
      {:else}
        {@render empty()}
      {/if}
    </div>

    {#if rows.length && flush}
      <footer
        class="flex shrink-0 items-center justify-between gap-3 border-t border-dark-4 px-3 py-2 text-xs text-dark-2"
      >
        <span class="tabular-nums">
          {num(firstShown)} to {num(lastShown)}{total !== undefined ? ` of ${num(total)}` : ''}
        </span>
        {#if acted.size}
          <!-- Offsets shift once items are decided, so paging on would skip some; reload re-cuts the page. -->
          <button type="button" class={LINK_CLASS} onclick={() => invalidateAll()}>
            Refresh queue ({acted.size} decided)
          </button>
        {:else}
          <span class="flex gap-2.5">
            {#if pageNumber > 1}
              <a href={pageHref(pageNumber - 1)} class={LINK_CLASS}>Prev</a>
            {:else}
              <span aria-disabled="true">Prev</span>
            {/if}
            {#if hasMore}
              <a href={pageHref(pageNumber + 1)} class={LINK_CLASS}>Next</a>
            {:else}
              <span aria-disabled="true">Next</span>
            {/if}
          </span>
        {/if}
      </footer>
    {:else if rows.length}
      <footer
        class="flex shrink-0 flex-wrap items-center gap-3 border-t border-dark-4 px-3 py-2 text-sm text-dark-0"
      >
        <span class="tabular-nums">
          {num(firstShown)}–{num(lastShown)}{total !== undefined ? ` of ${num(total)}` : ''}
        </span>
        {#if acted.size}
          <!-- Offsets shift once items are decided, so paging on would skip some; reload re-cuts the page. -->
          <Button size="sm" variant="outline" onclick={() => invalidateAll()}>
            Refresh queue ({acted.size} decided)
          </Button>
        {:else}
          {#if pageNumber > 1}<a href={pageHref(pageNumber - 1)} class={LINK_CLASS}>← Previous</a>{/if}
          {#if hasMore}<a href={pageHref(pageNumber + 1)} class={LINK_CLASS}>Next →</a>{/if}
        {/if}
      </footer>
    {/if}
  </aside>

  <section
    aria-label={itemLabel}
    class={cn(
      'flex min-h-0 min-w-0 flex-1 flex-col lg:overflow-hidden',
      flush ? 'bg-dark-8' : 'rounded-xl border border-dark-4 bg-dark-6'
    )}
  >
    {#if selected && selectedRowKey !== null}
      {@const key = selectedRowKey}
      {#key key}
        {@render detail(selected, {
          verdict: acted.get(key),
          error: errors.get(key),
          submit: (outcome) => submit(key, outcome),
        })}
      {/key}
    {:else}
      <div class="grid flex-1 place-items-center p-10 text-center text-base text-dark-0">
        {#if rows.length}
          {selectPrompt}
        {:else}
          {@render empty()}
        {/if}
      </div>
    {/if}
  </section>
</div>
