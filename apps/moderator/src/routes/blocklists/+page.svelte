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
  import { BLOCKLIST_TYPES, BLOCKLIST_DESCRIPTIONS, humanizeBlocklistType } from '$lib/blocklist';
  import { visibleBlocklistItems } from './filter';
  import type { ActionData, PageData } from './$types';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  let mode = $state<'add' | 'remove'>('add');
  let text = $state('');
  let filters = $state<Record<string, string>>({});
  let removing = $state<string | null>(null);

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
        await update();
        removing = null;
      };
    };
</script>

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
              class="{badgeVariants({ variant: 'secondary' })} gap-1 py-1 pl-3 pr-1"
            >
              <input type="hidden" name="id" value={data.blocklist.id} />
              <input type="hidden" name="blocklist" value={item} />
              {item}
              <Button
                type="submit"
                variant="ghost"
                size="icon"
                class="size-4"
                disabled={removing !== null}
                aria-label="Remove {item}"
                title="Remove {item}"
              >
                &times;
              </Button>
            </form>
          {/each}
        </div>
        {#if shown.matches.length > shown.visible.length}
          <p class="text-xs text-dark-2">
            Showing {shown.visible.length} of {shown.matches.length} matches. Narrow the filter to
            reach the rest.
          </p>
        {/if}
      {/if}
    </div>
  {/if}
</div>
