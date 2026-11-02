<script lang="ts">
  import { untrack } from 'svelte';
  import { enhance } from '$app/forms';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Checkbox } from '@civitai/ui/components/ui/checkbox/index.js';
  import { Label } from '@civitai/ui/components/ui/label/index.js';
  import {
    MultiCombobox,
    type MultiComboboxOption,
  } from '@civitai/ui/components/ui/multi-combobox/index.js';
  import { dateTime } from '$lib/format';
  import { sameOwners } from '$lib/queue-owners';
  import type { ActionData, PageData } from './$types';
  import type { OwnerView } from './+page.server';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  type Row = { path: string; label: string; owners: OwnerView[] };

  const rows = $derived<Row[]>([...data.queues, ...data.retired.map((r) => ({ ...r, label: r.path }))]);
  const baseline = () =>
    Object.fromEntries(
      [...data.queues, ...data.retired].map((r) => [r.path, r.owners.map((o) => o.id)])
    );

  // Seeded at declaration as well as in the effect: `$effect` does not run during SSR, and an empty
  // first paint would show every queue as unowned.
  let working = $state<Record<string, number[]>>(untrack(baseline));
  $effect(() => {
    working = baseline();
  });

  // The default `enhance` does not invalidate on failure, so `dirty` is unchanged when a refusal
  // arrives; this keeps the refusal on screen until the operator acts on it.
  let editedSinceAnswer = $state(false);
  $effect(() => {
    form;
    untrack(() => (editedSinceAnswer = false));
  });
  const showError = $derived(!!form?.error && !editedSinceAnswer);

  let unownedOnly = $state(false);

  const stored = (path: string) => rows.find((r) => r.path === path)?.owners ?? [];
  const changes = $derived(
    Object.fromEntries(
      Object.entries(working).filter(
        ([path, owners]) => !sameOwners(owners, stored(path).map((o) => o.id))
      )
    )
  );
  const dirty = $derived(Object.keys(changes).length);
  const expected = $derived(
    Object.fromEntries(Object.keys(changes).map((path) => [path, stored(path).map((o) => o.id)]))
  );

  // Counted on what is on screen, edits included, so assigning someone takes the queue off the count
  // before the save rather than after.
  const unownedCount = $derived(data.queues.filter((q) => !working[q.path]?.length).length);

  const sections = $derived.by(() => {
    const out: { section: string; queues: typeof data.queues }[] = [];
    for (const queue of data.queues) {
      if (unownedOnly && working[queue.path]?.length) continue;
      let group = out.find((s) => s.section === queue.section);
      if (!group) out.push((group = { section: queue.section, queues: [] }));
      group.queues.push(queue);
    }
    return out;
  });

  const moderatorOptions: MultiComboboxOption[] = $derived(
    data.moderators.map((m) => ({ value: String(m.id), label: m.username ?? `#${m.id}` }))
  );
  // A former moderator still on a queue must stay selectable, or their chip could not render.
  const optionsFor = (row: Row): MultiComboboxOption[] => [
    ...moderatorOptions,
    ...row.owners
      .filter((o) => o.former)
      .map((o) => ({
        value: String(o.id),
        label: `${o.username ?? `#${o.id}`} (no longer a moderator)`,
        disabled: true,
      })),
  ];

  function setOwners(path: string, ids: string[]) {
    editedSinceAnswer = true;
    working = { ...working, [path]: ids.map(Number) };
  }

  function revert() {
    editedSinceAnswer = true;
    working = baseline();
  }

  const names = (list: string[]) => list.join(', ') || 'nobody';
  const TH = 'py-2 pl-4 text-left text-xs tracking-wide text-dark-2 uppercase';
</script>

<svelte:head><title>Queue owners</title></svelte:head>

<header class="mb-4">
  <p class="text-sm"><a href="/admin" class="text-dark-2 underline">Permissions</a> ›</p>
  <h1 class="text-xl font-semibold text-white">Queue owners</h1>
  <p class="mt-2 text-sm text-dark-2">
    Who is responsible for keeping each queue covered. Owning a queue does not let anyone open it — that
    is still the role grants on <a href="/admin" class="underline">Permissions</a> — and it does not claim
    items: anyone with access can still work any queue. Each moderator sees the queues they own under
    <em>My tasks</em> on the dashboard.
  </p>
</header>

<div
  class="sticky top-0 z-10 mb-4 flex flex-wrap items-center gap-3 border-b border-dark-4 bg-background py-3 text-sm"
>
  <span
    role="status"
    class="flex-1"
    class:text-red-300={showError}
    class:text-dark-2={!showError}
  >
    {#if showError}
      {form?.error}{dirty
        ? ` Your ${dirty} unsaved change${dirty === 1 ? '' : 's'} ${dirty === 1 ? 'is' : 'are'} still on screen.`
        : ''}
    {:else if dirty}
      {dirty} queue{dirty === 1 ? '' : 's'} changed — not saved yet.
    {:else if form?.success}
      Saved {form.count} queue{form.count === 1 ? '' : 's'}.
    {:else}
      No unsaved changes.
    {/if}
  </span>
  <Button variant="outline" size="sm" disabled={!dirty} onclick={revert}>Revert</Button>
  <form method="POST" action="?/save" use:enhance>
    <input type="hidden" name="changes" value={JSON.stringify(changes)} />
    <input type="hidden" name="expect" value={JSON.stringify(expected)} />
    <Button type="submit" size="sm" disabled={!dirty}>Save</Button>
  </form>
</div>

<div class="mb-3 flex flex-wrap items-center gap-4">
  <p class="text-sm" class:text-yellow-300={unownedCount > 0} class:text-dark-2={!unownedCount}>
    {#if unownedCount}
      <strong>{unownedCount} of {data.queues.length} queues have no owner.</strong>
    {:else}
      Every queue has an owner.
    {/if}
  </p>
  <div class="flex items-center gap-2">
    <Checkbox id="unowned-only" bind:checked={() => unownedOnly, (v) => (unownedOnly = !!v)} />
    <Label for="unowned-only" class="text-sm">Show unowned only</Label>
  </div>
</div>

{#snippet ownerRow(row: Row, retired: boolean)}
  {@const owned = !!working[row.path]?.length}
  <tr class={['border-t border-dark-4 align-top', !owned && !retired && 'bg-yellow-500/5']}>
    <td class="py-2 pl-4">
      <div class="flex items-center gap-2">
        <span class="text-white">{row.label}</span>
        {#if !owned && !retired}<Badge variant="destructive">No owner</Badge>{/if}
      </div>
      <code class="text-xs text-dark-2">{row.path}</code>
    </td>
    <td class="py-2 pr-4 pl-4">
      <MultiCombobox
        options={optionsFor(row)}
        bind:value={
          () => (working[row.path] ?? []).map(String), (ids) => setOwners(row.path, ids)
        }
        placeholder={retired ? 'Remove the owners below' : 'Assign owners…'}
        class="min-w-64"
      />
      {#each row.owners.filter((o) => o.noAccess && working[row.path]?.includes(o.id)) as owner (owner.id)}
        <p class="mt-1 text-xs text-yellow-300">
          {owner.username ?? `#${owner.id}`} (no access): their roles cannot open this queue.
        </p>
      {/each}
    </td>
  </tr>
{/snippet}

<div class="overflow-x-auto rounded-xl border border-dark-4 bg-dark-6">
  <table class="w-full min-w-xl text-sm">
    <caption class="sr-only">Owners per queue</caption>
    <thead>
      <tr>
        <th class={TH}>Queue</th>
        <th class={TH}>Owners</th>
      </tr>
    </thead>
    <tbody>
      {#each sections as group (group.section)}
        <tr class="border-t border-dark-4">
          <th colspan="2" class="bg-dark-5 py-1.5 pl-4 text-left text-xs font-semibold text-dark-1">
            {group.section}
          </th>
        </tr>
        {#each group.queues as queue (queue.path)}
          {@render ownerRow(queue, false)}
        {/each}
      {:else}
        <tr><td colspan="2" class="p-4 text-dark-2">Every queue has an owner.</td></tr>
      {/each}
    </tbody>
  </table>
</div>

{#if data.retired.length}
  <h2 class="mt-6 mb-2 text-sm font-semibold text-white">Retired queues</h2>
  <p class="mb-3 text-sm text-dark-2">
    Owners stored against a page that is no longer a queue, after it was renamed or removed. They cover
    nothing: remove them, and assign the queue's new page above if it has one.
  </p>
  <div class="overflow-x-auto rounded-xl border border-dark-4 bg-dark-6">
    <table class="w-full min-w-xl text-sm">
      <caption class="sr-only">Owners on retired queues</caption>
      <tbody>
        {#each data.retired as row (row.path)}
          {@render ownerRow({ ...row, label: row.path }, true)}
        {/each}
      </tbody>
    </table>
  </div>
{/if}

<h2 class="mt-6 mb-2 text-sm font-semibold text-white">Recent changes</h2>
{#if data.changes.length}
  <div class="overflow-x-auto rounded-xl border border-dark-4 bg-dark-6">
    <table class="w-full min-w-xl text-sm">
      <caption class="sr-only">Recent queue owner changes</caption>
      <thead>
        <tr>
          <th class={TH}>When</th>
          <th class={TH}>By</th>
          <th class={TH}>Queue</th>
          <th class={TH}>Before</th>
          <th class={TH}>After</th>
        </tr>
      </thead>
      <tbody>
        {#each data.changes as change (change.id)}
          <tr class="border-t border-dark-4">
            <td class="py-2 pl-4 whitespace-nowrap text-dark-2">{dateTime(change.at)}</td>
            <td class="py-2 pl-4">{change.actorName ?? `#${change.actorId}`}</td>
            <td class="py-2 pl-4"><code class="text-xs">{change.path}</code></td>
            <td class="py-2 pl-4 text-dark-2">{names(change.beforeNames)}</td>
            <td class="py-2 pr-4 pl-4">{names(change.afterNames)}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{:else}
  <p class="text-sm text-dark-2">No changes yet.</p>
{/if}
