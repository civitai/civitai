<script lang="ts">
  import { untrack } from "svelte";
  import { page } from "$app/state";
  import { enhance } from '$app/forms';
  import { goto } from '$app/navigation';
  import type { SubmitFunction } from '@sveltejs/kit';
  import { Tabs, TabsList, TabsTrigger } from '@civitai/ui/components/ui/tabs/index.js';
  import { Textarea } from '@civitai/ui/components/ui/textarea/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import {
    BLOCKLIST_TYPES,
    BLOCKLIST_DESCRIPTIONS,
    humanizeBlocklistType,
    visibleBlocklistItems,
  } from '$lib/blocklist';
  import type { ActionData, PageData } from './$types';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  let mode = $state<'add' | 'remove'>('add');
  let text = $state('');
  let filter = $state('');

  // EmailDomain is 8295 entries in production. Rendering the whole list is both unusable and
  // enough DOM to stall the tab, so the list is filtered first and then capped.
  const CHIP_LIMIT = 200;

  // Keyed on the URL — the tab is `?type=`. Depending on `data` instead meant every successful add or
  // remove (which invalidates) also forced `mode` back to 'add', so a moderator part-way through a
  // bulk removal was silently returned to Add.
  const subject = $derived(page.url.search);
  $effect(() => {
    subject;
    untrack(() => {
      text = '';
      mode = 'add';
      filter = '';
    });
  });

  const sortedItems = $derived([...data.blocklist.data].sort());
  const shown = $derived(visibleBlocklistItems(sortedItems, filter, CHIP_LIMIT));
  const matches = $derived(shown.matches);
  const visibleItems = $derived(shown.visible);

  function setMode(next: 'add' | 'remove') {
    mode = next;
    text = '';
  }

  const submit: SubmitFunction = () => async ({ result, update }) => {
    if (result.type === 'success') text = '';
    await update(); // re-runs load → fresh blocklist (and the shared Redis cache is already updated)
  };

  // Deliberately does NOT clear `text`: a chip is its own form, so wiping the textarea would throw
  // away a bulk edit the moderator is part-way through typing.
  const submitChip: SubmitFunction = () => async ({ update }) => {
    await update();
  };
</script>

<header class="page-header">
  <h1>Blocklists</h1>
</header>

<Tabs value={data.type} onValueChange={(v) => v && goto(`?type=${v}`)} class="mb-4">
  <TabsList>
    {#each BLOCKLIST_TYPES as t (t)}
      <TabsTrigger value={t}>{humanizeBlocklistType(t)}</TabsTrigger>
    {/each}
  </TabsList>
</Tabs>

{#if BLOCKLIST_DESCRIPTIONS[data.type]}
  <p class="mb-4 max-w-xl text-sm text-muted-foreground">{BLOCKLIST_DESCRIPTIONS[data.type]}</p>
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
    <p class="text-sm text-muted-foreground">No items in this blocklist.</p>
  {:else}
    <div class="flex flex-col gap-2">
      <span class="text-sm font-medium">{humanizeBlocklistType(data.type)} ({sortedItems.length})</span>
      <Input bind:value={filter} placeholder="Filter entries" />
      {#if matches.length === 0}
        <p class="text-sm text-muted-foreground">No entry contains "{filter.trim()}".</p>
      {:else}
        <div class="flex flex-wrap gap-2">
          {#each visibleItems as item (item)}
            <span
              class="flex items-center gap-1 rounded-md bg-muted py-1 pl-3 pr-1 text-xs font-medium text-muted-foreground ring-1 ring-inset ring-border"
            >
              {item}
              <form method="POST" action="?/remove" use:enhance={submitChip} class="flex">
                <input type="hidden" name="id" value={data.blocklist.id} />
                <input type="hidden" name="blocklist" value={item} />
                <button
                  type="submit"
                  aria-label="Remove {item}"
                  title="Remove {item}"
                  class="rounded px-1 leading-none text-muted-foreground hover:bg-red-500/15 hover:text-red-300"
                >
                  &times;
                </button>
              </form>
            </span>
          {/each}
        </div>
        {#if matches.length > visibleItems.length}
          <p class="text-xs text-muted-foreground">
            Showing {visibleItems.length} of {matches.length} matches. Narrow the filter to reach the
            rest.
          </p>
        {/if}
      {/if}
    </div>
  {/if}
</div>
