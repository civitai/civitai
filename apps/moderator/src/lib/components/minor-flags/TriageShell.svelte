<script lang="ts" generics="K extends string | number, R">
  import { afterNavigate, invalidateAll, replaceState } from '$app/navigation';
  import { page } from '$app/state';
  import type { ActionResult, SubmitFunction } from '@sveltejs/kit';
  import { tick, type Snippet } from 'svelte';
  import { SvelteMap } from 'svelte/reactivity';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';
  import { LINK_CLASS, num } from '$lib/format';
  import { optimisticEnhancer } from '$lib/form-action';
  import {
    failureMessage,
    isTypingTarget,
    nextUndecided,
    step,
    triageKeyAction,
  } from '$lib/minor-flags/appeal-triage';
  import { urlWith } from '$lib/url';

  type QueueForm = { error?: string; modelId?: number } | null;
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
    submit: (outcome: string) => SubmitFunction;
  };

  /**
   * The master-detail triage both flag queues share: a list on the left, the open item on the right,
   * J/K to move, 1/2 to rule, and the list dimming decided items in place (offsets shift under
   * paging, so the page is only re-cut on request). The queues supply the rows and what they show.
   */
  let {
    rows,
    rowKey,
    parseKey,
    selectionParam,
    queueLabel,
    itemLabel,
    canKeep,
    canUnflag = () => true,
    outcomeFor = (_result, outcome) => outcome,
    pageNumber,
    hasMore,
    offset,
    total,
    form,
    listRow,
    detail,
    empty,
    notice,
  }: {
    rows: R[];
    rowKey: (row: R) => K;
    /** Reads the selection back out of the URL param. */
    parseKey: (raw: string) => K | null;
    selectionParam: string;
    /** Accessible names for the list and detail regions. */
    queueLabel: string;
    itemLabel: string;
    /** Gate for the "1" shortcut. */
    canKeep: (row: R) => boolean;
    /** Gate for the "2" shortcut. */
    canUnflag?: (row: R) => boolean;
    /** Lets a queue relabel a success, e.g. when the main app reports nothing was left to do. */
    outcomeFor?: (result: ActionResult, outcome: string) => string;
    pageNumber: number;
    hasMore: boolean;
    offset: number;
    total?: number;
    form: QueueForm | undefined;
    listRow: Snippet<[R, RowState]>;
    detail: Snippet<[R, DetailState]>;
    empty: Snippet;
    notice?: Snippet;
  } = $props();

  const keys = $derived(rows.map(rowKey));

  const keyInUrl = () => {
    const raw = page.url.searchParams.get(selectionParam);
    return raw ? parseKey(raw) : null;
  };

  let selectedKey = $state<K | null>(keyInUrl());
  const selected = $derived(rows.find((r) => rowKey(r) === selectedKey) ?? rows[0]);
  const selectedRowKey = $derived(selected ? rowKey(selected) : null);

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
    if (selectedKey !== null && !keys.includes(selectedKey)) selectedKey = null;
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
    const next = nextUndecided(keys, decidedKey, (key) => acted.has(key));
    if (next === null) return;
    select(next);
    await tick();
    document.querySelector<HTMLElement>(`#${rowId(next)} a`)?.focus({ preventScroll: true });
  };

  const submit = (key: K, outcome: string): SubmitFunction => {
    const decide = optimisticEnhancer(() => {
      errors.delete(key);
      acted.set(key, outcome);
      return () => acted.delete(key);
    });
    return async (input) => {
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
          acted.set(key, outcomeFor(result.result, outcome));
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
      canUphold: !!selected && canKeep(selected),
      canOverturn: !!selected && canUnflag(selected),
    });
    if (!action) return;
    e.preventDefault();
    if (action === 'next' || action === 'previous') {
      const to = step(keys, selectedRowKey, action === 'next' ? 1 : -1);
      if (to !== null) select(to);
    } else if (!e.repeat) {
      document
        .querySelector<HTMLFormElement>(
          `[data-triage-actions] form[data-triage-action="${action}"]`
        )
        ?.requestSubmit();
    }
  }

  const pageHref = (n: number) => urlWith(page.url, { page: n, [selectionParam]: null });
  // Not inline: `{/` opens a closing tag in a template.
  const selectPrompt = $derived(
    `Select ${/^[aeiou]/i.test(itemLabel) ? 'an' : 'a'} ${itemLabel.toLowerCase()} from the queue.`
  );
  const firstShown = $derived(offset + 1);
  const lastShown = $derived(offset + rows.length);
</script>

<svelte:window {onkeydown} />

{#if form?.error && errors.size === 0}
  <ErrorAlert message={form.modelId ? `Model #${form.modelId}: ${form.error}` : form.error} />
{/if}
{@render notice?.()}

<div class="flex min-h-0 flex-1 flex-col gap-4 lg:flex-row">
  <aside
    aria-label={queueLabel}
    class="flex max-h-80 min-h-0 flex-col overflow-hidden rounded-xl border border-dark-4 bg-dark-6 lg:max-h-none lg:w-[35%] lg:max-w-[36rem] lg:min-w-80 lg:shrink-0"
  >
    <div class="min-h-0 flex-1 overflow-y-auto">
      {#if rows.length}
        <ul class="m-0 list-none divide-y divide-dark-4 p-0">
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

    {#if rows.length}
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
    class="flex min-h-0 min-w-0 flex-1 flex-col rounded-xl border border-dark-4 bg-dark-6 lg:overflow-hidden"
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
