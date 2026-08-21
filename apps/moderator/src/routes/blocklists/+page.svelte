<script lang="ts">
  import { untrack } from "svelte";
  import { page } from "$app/state";
  import { enhance } from '$app/forms';
  import { goto } from '$app/navigation';
  import type { SubmitFunction } from '@sveltejs/kit';
  import { Tabs, TabsList, TabsTrigger } from '@civitai/ui/components/ui/tabs/index.js';
  import { Textarea } from '@civitai/ui/components/ui/textarea/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { badgeVariants } from '@civitai/ui/components/ui/badge/index.js';
  import ListFilterBar from '$lib/components/ListFilterBar.svelte';
  import { num } from '$lib/format';
  import { BLOCKLIST_TYPES, BLOCKLIST_DESCRIPTIONS, humanizeBlocklistType } from '$lib/blocklist';
  import { visibleBlocklistItems } from './filter';
  import type { ActionData, PageData } from './$types';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  let mode = $state<'add' | 'remove'>('add');
  let text = $state('');
  let filters = $state<Record<string, string>>({});
  let removing = $state<string | null>(null);
  let confirming = $state<string | null>(null);

  // EmailDomain is 8295 entries in production. Rendering the whole list is both unusable and
  // enough DOM to stall the tab, so the list is filtered first and then capped.
  const CHIP_LIMIT = 200;

  // Keyed on the URL — the tab is `?type=`. Depending on `data` instead meant every successful add or
  // remove (which invalidates) also forced `mode` back to 'add', so a moderator part-way through a
  // bulk removal was silently returned to Add.
  const subject = $derived(page.url.search);
  $effect(() => {
    subject;
    untrack(resetForTab);
  });

  function resetForTab() {
    text = '';
    mode = 'add';
    filters = {};
    confirming = null;
  }

  function setMode(next: 'add' | 'remove') {
    mode = next;
    text = '';
  }

  // Duplicates are reachable: `upsertBlocklist` dedupes only on its update branch, so the first save
  // of a type persists whatever was submitted. They would collide as `{#each}` keys, and each chip
  // now carries a remove control identified by that same string.
  const sortedItems = $derived(
    [...new Set(data.blocklist.data)].sort((a, b) => a.localeCompare(b))
  );
  const shown = $derived(visibleBlocklistItems(sortedItems, filters.q ?? '', CHIP_LIMIT));

  const submit: SubmitFunction = () => async ({ result, update }) => {
    if (result.type === 'success') text = '';
    await update(); // re-runs load → fresh blocklist (and the shared Redis cache is already updated)
  };

  // Deliberately does NOT clear `text`: a chip is its own form, so wiping the textarea would throw
  // away a bulk edit the moderator is part-way through typing. `removing` disables every chip for
  // the duration, because two overlapping removals read-modify-write the same array and the later
  // write restores what the earlier one dropped.
  const submitChip =
    (item: string): SubmitFunction =>
    () => {
      removing = item;
      return async ({ update }) => {
        // `finally`, not a bare sequence. Every chip's control is disabled while `removing` is set,
        // so a submit that throws — a rejected fetch, a cross-origin refusal — would otherwise leave
        // it set forever and kill EVERY remove control on the page until a reload, with the click
        // doing nothing and no error to read.
        try {
          await update();
        } finally {
          removing = null;
          // Cleared here rather than in the confirm button's own click handler. Svelte flushes
          // effects synchronously after a DOM event handler, so clearing it there unmounts the
          // submitter through its `{#if}` before the browser runs the form's activation behaviour —
          // the submit never fires and "Remove" behaves exactly like "Cancel", silently. Same trap
          // as `ConfirmSubmit.svelte`.
          confirming = null;
        }
      };
    };
</script>

<!-- One window listener rather than one per chip: at CHIP_LIMIT that would be 200 of them. -->
<svelte:window
  onkeydown={(e) => {
    if (e.key === 'Escape') confirming = null;
  }}
/>

<header class="page-header">
  <h1>Blocklists</h1>
</header>

<Tabs
  value={data.type}
  onValueChange={(v) => {
    if (!v) return;
    // Reset here as well as in the effect: the effect runs after the DOM is written, so on a tab
    // change the new type's entries would render against the old tab's filter for a frame.
    resetForTab();
    goto(`?type=${v}`);
  }}
  class="mb-4"
>
  <TabsList>
    {#each BLOCKLIST_TYPES as t (t)}
      <TabsTrigger value={t}>{humanizeBlocklistType(t)}</TabsTrigger>
    {/each}
  </TabsList>
</Tabs>

{#if BLOCKLIST_DESCRIPTIONS[data.type]}
  <p class="mb-4 max-w-xl text-sm text-dark-2">{BLOCKLIST_DESCRIPTIONS[data.type]}</p>
{/if}

{#if form?.error}
  <ErrorAlert class="mb-4 max-w-xl" message={form.error} />
{:else if form?.success}
  <div class="mb-4 max-w-xl rounded-md border border-teal-500/30 bg-teal-500/10 p-2 text-sm text-teal-300">
    {form.action === 'add' ? 'Added' : 'Removed'} {form.count} item{form.count === 1 ? '' : 's'}.
  </div>
{/if}

<div class="flex max-w-xl flex-col gap-4">
  <div class="flex flex-col gap-2 rounded-xl border p-3">
    {#if data.blocklist.id}
      <div class="flex gap-1">
        <Button size="sm" variant={mode === 'add' ? 'default' : 'outline'} onclick={() => setMode('add')}>
          Add
        </Button>
        <Button
          size="sm"
          variant={mode === 'remove' ? 'default' : 'outline'}
          onclick={() => setMode('remove')}
        >
          Remove
        </Button>
      </div>
    {/if}

    <form
      method="POST"
      action={mode === 'add' ? '?/add' : '?/remove'}
      use:enhance={submit}
      class="flex flex-col gap-2"
    >
      <input type="hidden" name="type" value={data.type} />
      {#if data.blocklist.id}<input type="hidden" name="id" value={data.blocklist.id} />{/if}
      <Textarea
        name="blocklist"
        bind:value={text}
        placeholder={mode === 'add'
          ? 'Add comma-delimited items to blocklist'
          : 'Remove comma-delimited items from blocklist'}
      />
      <div class="flex justify-end">
        <Button type="submit" disabled={text.trim().length === 0}>Submit</Button>
      </div>
    </form>
  </div>

  {#if sortedItems.length === 0}
    <p class="text-sm text-dark-2">No items in this blocklist.</p>
  {:else}
    <div class="flex flex-col gap-2">
      <span class="text-sm font-medium">{humanizeBlocklistType(data.type)}</span>
      <ListFilterBar
        fields={[{ kind: 'search', key: 'q', label: 'Filter entries' }]}
        bind:values={filters}
        matched={shown.matches.length}
        total={sortedItems.length}
      />
      {#if shown.matches.length === 0}
        <p class="text-sm text-dark-2">Nothing on this list matches "{(filters.q ?? '').trim()}".</p>
      {:else}
        <div class="flex flex-wrap gap-2">
          {#each shown.visible as item (item)}
            <form
              method="POST"
              action="?/remove"
              use:enhance={submitChip(item)}
              class="relative"
            >
              <input type="hidden" name="id" value={data.blocklist.id} />
              <input type="hidden" name="blocklist" value={item} />
              <!-- The badge styling stays on this span, NOT on the form. `badgeVariants` carries
                   `overflow-hidden` and a fixed `h-5`, so a confirm rendered inside a badge-styled
                   element is clipped away to nothing: present in the DOM, invisible on screen, and
                   the X reads as a dead control. That cost several review rounds. -->
              <span class="{badgeVariants({ variant: 'secondary' })} gap-1 py-1 pl-3 pr-1">
                {item}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  class="size-4"
                  disabled={removing !== null}
                  aria-label="Remove {item}"
                  title="Remove {item}"
                  onclick={() => (confirming = item)}
                >
                  &times;
                </Button>
              </span>

              <!-- Anchored inside the form rather than portalled: a portalled confirm is outside the
                   <form> in the DOM, so its submit button loses the implicit association and posts
                   nothing. Absolute so opening it cannot reflow a 200-chip wrapped list.
                   🔴 Opens DOWNWARD. Upward put it underneath the filter bar's input, which paints
                   over it — the confirm was there and invisible, so the X read as a dead control.
                   z-50 for the same reason: it has to clear the chips it overlaps. -->
              {#if confirming === item}
                <div
                  class="absolute left-0 top-full z-50 mt-1 flex w-max items-center gap-2 rounded-md border bg-popover p-2 text-popover-foreground shadow-md"
                >
                  <span class="text-xs">Remove <strong>{item}</strong>?</span>
                  <Button type="submit" size="sm" variant="destructive" disabled={removing !== null}>
                    Remove
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onclick={() => (confirming = null)}
                  >
                    Cancel
                  </Button>
                </div>
              {/if}
            </form>
          {/each}
        </div>
        {#if shown.matches.length > shown.visible.length}
          <p class="text-xs text-dark-2">
            Showing {num(shown.visible.length)} of {num(shown.matches.length)} matches. Narrow the
            filter to reach the rest.
          </p>
        {/if}
      {/if}
    </div>
  {/if}
</div>
