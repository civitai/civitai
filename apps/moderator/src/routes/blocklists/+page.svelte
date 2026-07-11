<script lang="ts">
  import { enhance } from '$app/forms';
  import { goto } from '$app/navigation';
  import type { SubmitFunction } from '@sveltejs/kit';
  import { Tabs, TabsList, TabsTrigger } from '@civitai/ui/components/ui/tabs/index.js';
  import { Textarea } from '@civitai/ui/components/ui/textarea/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { BLOCKLIST_TYPES, BLOCKLIST_DESCRIPTIONS, humanizeBlocklistType } from '$lib/blocklist';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  let mode = $state<'add' | 'remove'>('add');
  let text = $state('');

  // Reset the input + mode whenever a different type tab loads.
  $effect(() => {
    data.type;
    text = '';
    mode = 'add';
  });

  const sortedItems = $derived([...data.blocklist.data].sort());

  function setMode(next: 'add' | 'remove') {
    mode = next;
    text = '';
  }

  function stageForRemoval(item: string) {
    if (mode !== 'remove') return;
    const current = text
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (!current.includes(item)) text = [...current, item].join(', ');
  }

  const submit: SubmitFunction = () => async ({ result, update }) => {
    if (result.type === 'success') text = '';
    await update(); // re-runs load → fresh blocklist (and the shared Redis cache is already updated)
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
  <div class="mb-4 max-w-xl rounded-md border border-red-500/30 bg-red-500/10 p-2 text-sm text-red-300">
    {form.error}
  </div>
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
      <div class="flex flex-wrap gap-2">
        {#each sortedItems as item (item)}
          <button
            type="button"
            disabled={mode !== 'remove'}
            onclick={() => stageForRemoval(item)}
            class="rounded-md bg-muted px-3 py-1 text-xs font-medium text-muted-foreground ring-1 ring-inset ring-border {mode ===
            'remove'
              ? 'cursor-pointer hover:bg-red-500/15 hover:text-red-300'
              : 'cursor-default'}"
          >
            {item}
          </button>
        {/each}
      </div>
    </div>
  {/if}
</div>
