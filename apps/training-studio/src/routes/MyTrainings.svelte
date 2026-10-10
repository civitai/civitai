<script lang="ts">
  import type { Snippet } from 'svelte';
  import { SvelteSet } from 'svelte/reactivity';
  import {
    IconAlertTriangle,
    IconLayoutGrid,
    IconList,
    IconPlus,
    IconTrash,
    IconX,
  } from '@tabler/icons-svelte';
  import * as AlertDialog from '@civitai/ui/components/ui/alert-dialog/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import * as Select from '@civitai/ui/components/ui/select/index.js';
  import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
  } from '@civitai/ui/components/ui/table/index.js';
  import {
    ToggleGroup,
    ToggleGroupItem,
  } from '@civitai/ui/components/ui/toggle-group/index.js';
  import { backend, browser, hrefFor, portalProps } from '$lib/host';
  import { locationHref } from '$lib/actions/locationHref';
  import { remixFromRun } from '$lib/reuse';
  import { submitNotice } from '$lib/submit-notice.svelte';
  import RunStateBadge from '$lib/components/RunStateBadge.svelte';
  import SampleGrid from '$lib/components/SampleGrid.svelte';
  import GradientTile from '$lib/components/GradientTile.svelte';
  import {
    canDeleteRun,
    RUN_STATE_BADGE,
    type RunState,
    type TrainingRow,
  } from '$lib/data/trainingRows';

  let { rows, onNew }: { rows: TrainingRow[]; onNew: () => void } = $props();

  // Cards for browsing samples; the table for people running many trainings at once. Persisted —
  // the choice is a workflow preference, not a per-visit one.
  const VIEW_KEY = 'ts-trainings-view';
  let view = $state<'cards' | 'list'>(
    browser && localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'cards'
  );
  function setView(next: 'cards' | 'list') {
    view = next;
    try {
      if (browser) localStorage.setItem(VIEW_KEY, next);
    } catch {
      // Storage blocked — the choice just doesn't persist.
    }
  }

  // Remix / Retry reuse a run's dataset. Track which card is in flight and surface a failure inline, so the
  // button never looks like a dead click (it navigates away on success).
  let remixingId = $state<string | null>(null);
  let remixError = $state('');
  async function remix(workflowId: string) {
    if (remixingId) return;
    remixingId = workflowId;
    remixError = '';
    try {
      await remixFromRun(workflowId);
    } catch (err) {
      remixError = err instanceof Error ? err.message : 'Could not reuse that dataset.';
    } finally {
      remixingId = null;
    }
  }

  // `rows` is load data (shell) or a resolved promise (element), so a delete hides the row here
  // rather than re-fetching the list.
  const deletedIds = new SvelteSet<string>();
  let deleteTarget = $state<TrainingRow | null>(null);
  let deleting = $state(false);
  let deleteError = $state('');
  function askDelete(r: TrainingRow) {
    deleteTarget = r;
    deleteError = '';
  }
  async function confirmDelete() {
    const workflowId = deleteTarget?.workflowId;
    if (!workflowId || deleting) return;
    deleting = true;
    deleteError = '';
    try {
      await backend().deleteTraining(workflowId);
      deletedIds.add(workflowId);
      deleteTarget = null;
    } catch (err) {
      deleteError = err instanceof Error ? err.message : 'Could not delete this training.';
    } finally {
      deleting = false;
    }
  }

  const ALL = 'all';
  let baseFilter = $state(ALL);
  let stateFilter = $state(ALL);

  const liveRows = $derived(rows.filter((r) => !(r.workflowId && deletedIds.has(r.workflowId))));
  const baseOptions = $derived([...new Set(liveRows.map((r) => r.baseFamily))].sort());
  const stateOptions = $derived(
    (Object.keys(RUN_STATE_BADGE) as RunState[]).filter((s) => liveRows.some((r) => r.state === s))
  );
  // A choice whose last row was deleted drops back to "all" rather than filtering to nothing.
  const activeBase = $derived(baseOptions.includes(baseFilter) ? baseFilter : ALL);
  const activeState: RunState | typeof ALL = $derived(
    stateOptions.find((s) => s === stateFilter) ?? ALL
  );
  const visibleRows = $derived(
    liveRows.filter(
      (r) =>
        (activeBase === ALL || r.baseFamily === activeBase) &&
        (activeState === ALL || r.state === activeState)
    )
  );
  const filtered = $derived(activeBase !== ALL || activeState !== ALL);
  function clearFilters() {
    baseFilter = ALL;
    stateFilter = ALL;
  }
</script>

{#snippet rowActions(r: TrainingRow)}
  <!-- Disabled whenever a click would silently no-op: no workflow to remix, or ANY remix already
       in flight (remix() early-returns then) — "the button never looks like a dead click". -->
  <Button
    variant="outline"
    size="sm"
    disabled={!r.workflowId || remixingId !== null}
    onclick={() => r.workflowId && remix(r.workflowId)}
  >
    {remixingId === r.workflowId ? 'Loading…' : r.state === 'failed' ? 'Retry' : 'Remix'}
  </Button>
  {#if r.workflowId && canDeleteRun(r)}
    <Button
      variant="ghost"
      size="sm"
      class="text-dark-2 hover:bg-red-500/15 hover:text-red-400"
      aria-label={`Delete ${r.name}`}
      onclick={() => askDelete(r)}
    >
      <IconTrash size={15} stroke={2} />
    </Button>
  {/if}
{/snippet}

{#snippet emptyState(message: string, action: Snippet)}
  <div class="rounded-xl border border-dashed border-dark-4 bg-dark-6 p-10 text-center">
    <p class="text-sm text-dark-2">{message}</p>
    {@render action()}
  </div>
{/snippet}

<section class="flex flex-col gap-5">
  <div class="flex flex-wrap items-center justify-between gap-3">
    <div>
      <h2 class="m-0 text-xl font-semibold text-white">My trainings</h2>
      <p class="mt-1 text-sm text-dark-2">
        Runs stay here for 30 days. Publish one and the model lives on Civitai for good, though the run
        itself still leaves this list.
      </p>
    </div>
    <div class="flex items-center gap-2">
      <!-- Function binding: bits-ui writes '' into its copy when the active item is re-clicked, and
           a one-way prop wouldn't push the selection back — the getter re-asserts it. -->
      <ToggleGroup
        type="single"
        bind:value={() => view, (v) => v && setView(v as 'cards' | 'list')}
        variant="outline"
        size="sm"
      >
        <ToggleGroupItem value="cards" aria-label="Card view">
          <IconLayoutGrid size={15} stroke={2} />
        </ToggleGroupItem>
        <ToggleGroupItem value="list" aria-label="List view">
          <IconList size={15} stroke={2} />
        </ToggleGroupItem>
      </ToggleGroup>
      <Button onclick={onNew}><IconPlus size={15} stroke={2} class="mr-1.5 inline" />New training</Button>
    </div>
  </div>

  {#if submitNotice.message}
    <div
      role="alert"
      class="flex items-start gap-2 rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 text-xs text-red-400"
    >
      <IconAlertTriangle size={15} stroke={2} class="mt-px shrink-0" />
      <p class="m-0 flex-1 font-mono">{submitNotice.message}</p>
      <button
        type="button"
        aria-label="Dismiss"
        onclick={() => submitNotice.clear()}
        class="shrink-0 text-dark-2 transition hover:text-white"
      >
        <IconX size={14} stroke={2} />
      </button>
    </div>
  {/if}

  {#if remixError}
    <p
      class="rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 font-mono text-xs text-red-400"
    >
      {remixError}
    </p>
  {/if}

  {#if liveRows.length > 0}
    <div class="flex flex-wrap items-center gap-2">
      <Select.Root type="single" bind:value={() => activeBase, (v) => (baseFilter = v)}>
        <Select.Trigger
          size="sm"
          class="min-w-[10rem] font-mono text-xs"
          aria-label="Filter by base model"
        >
          {activeBase === ALL ? 'All base models' : activeBase}
        </Select.Trigger>
        <Select.Content portalProps={portalProps()}>
          <Select.Item value={ALL}>All base models</Select.Item>
          {#each baseOptions as b (b)}
            <Select.Item value={b}>{b}</Select.Item>
          {/each}
        </Select.Content>
      </Select.Root>
      <Select.Root type="single" bind:value={() => activeState, (v) => (stateFilter = v)}>
        <Select.Trigger
          size="sm"
          class="min-w-[8rem] font-mono text-xs"
          aria-label="Filter by status"
        >
          {activeState === ALL ? 'All statuses' : RUN_STATE_BADGE[activeState].label}
        </Select.Trigger>
        <Select.Content portalProps={portalProps()}>
          <Select.Item value={ALL}>All statuses</Select.Item>
          {#each stateOptions as s (s)}
            <Select.Item value={s}>{RUN_STATE_BADGE[s].label}</Select.Item>
          {/each}
        </Select.Content>
      </Select.Root>
      {#if filtered}
        <Button variant="ghost" size="sm" onclick={clearFilters}>Clear filters</Button>
        <span class="font-mono text-xs text-dark-2">
          {visibleRows.length} of {liveRows.length}
        </span>
      {/if}
    </div>
  {/if}

  {#if liveRows.length === 0}
    {#snippet startFirst()}
      <Button class="mt-3" onclick={onNew}>
        <IconPlus size={15} stroke={2} class="mr-1.5 inline" />Start your first training
      </Button>
    {/snippet}
    {@render emptyState('No trainings yet.', startFirst)}
  {:else if visibleRows.length === 0}
    {#snippet clearAction()}
      <Button class="mt-3" variant="outline" onclick={clearFilters}>Clear filters</Button>
    {/snippet}
    {@render emptyState('No trainings match these filters.', clearAction)}
  {:else if view === 'list'}
    <div class="overflow-hidden rounded-xl border border-dark-4 bg-dark-6">
      <Table>
        <TableHeader>
          <TableRow class="border-dark-4 hover:bg-transparent">
            <TableHead class="px-4 font-mono text-xs uppercase tracking-wider text-dark-2">
              Name
            </TableHead>
            <TableHead class="px-4 font-mono text-xs uppercase tracking-wider text-dark-2">
              Base
            </TableHead>
            <TableHead class="px-4 font-mono text-xs uppercase tracking-wider text-dark-2">
              Status
            </TableHead>
            <TableHead class="px-4 font-mono text-xs uppercase tracking-wider text-dark-2">
              Progress
            </TableHead>
            <TableHead class="px-4 text-right"><span class="sr-only">Actions</span></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {#each visibleRows as r (r.workflowId ?? r.name)}
            <TableRow class="border-dark-4/60 hover:bg-dark-5/40">
              <TableCell class="max-w-[24ch] truncate px-4 py-2.5 font-semibold text-dark-0">
                {#if r.workflowId}
                  <a
                    href={hrefFor({ view: 'run', workflowId: r.workflowId })}
                    use:locationHref={{ view: 'run', workflowId: r.workflowId }}
                    class="underline decoration-dark-3 underline-offset-2 hover:text-white hover:decoration-current"
                  >
                    {r.name}
                  </a>
                {:else}
                  {r.name}
                {/if}
              </TableCell>
              <TableCell class="whitespace-nowrap px-4 py-2.5">
                <span class="font-mono text-xs text-dark-2">{r.base}</span>
              </TableCell>
              <TableCell class="px-4 py-2.5"><RunStateBadge state={r.state} /></TableCell>
              <TableCell class="max-w-[32ch] whitespace-normal px-4 py-2.5 font-mono text-xs text-dark-2">
                {#if r.state === 'training'}
                  {r.progressPct > 0 ? `${r.progressPct}% · ` : ''}{r.progress}
                {:else}
                  {r.sub}
                {/if}
              </TableCell>
              <TableCell class="whitespace-nowrap px-4 py-2.5 text-right">
                {@render rowActions(r)}
              </TableCell>
            </TableRow>
          {/each}
        </TableBody>
      </Table>
    </div>
  {:else}
    <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {#each visibleRows as r (r.workflowId ?? r.name)}
        <div
          class="group relative flex flex-col overflow-hidden rounded-xl border border-dark-4 bg-dark-6 transition-colors hover:border-dark-3 hover:bg-dark-5/50"
        >
          <!-- Stretched link: the whole card opens the run. Sits under the action buttons (z-index below), so
               clicking the title/samples navigates while the buttons keep their own behaviour. -->
          {#if r.workflowId}
            <a
              href={hrefFor({ view: 'run', workflowId: r.workflowId })}
              use:locationHref={{ view: 'run', workflowId: r.workflowId }}
              class="absolute inset-0 z-[1]"
              aria-label={`Open ${r.name}`}
            ></a>
          {/if}

          <!-- Badge shares the title's line so the second line gets the full card width: it carries the
               refund notice on a failed run, which must not be lost to truncation. -->
          <div class="border-b border-dark-4 p-3.5">
            <div class="flex items-center gap-3">
              <div
                class="min-w-0 flex-1 truncate text-sm font-bold text-dark-0 transition-colors group-hover:text-white"
              >
                {r.name}
              </div>
              <RunStateBadge state={r.state} />
            </div>
            <div class="mt-0.5 break-words font-mono text-xs text-dark-2">
              <span class="font-bold text-dark-0">{r.base}</span>{r.sub ? ` · ${r.sub}` : ''}
            </div>
          </div>

          <div class="p-3.5">
            {#if r.state === 'training'}
              <div
                class="h-1.5 overflow-hidden rounded-full bg-dark-7"
                role="progressbar"
                aria-label="Training progress"
                aria-valuenow={r.progressPct > 0 ? r.progressPct : undefined}
                aria-valuemin={0}
                aria-valuemax={100}
              >
                {#if r.progressPct > 0}
                  <div class="h-full bg-buzz" style={`width:${r.progressPct}%`}></div>
                {:else}
                  <div class="h-full w-1/3 animate-pulse bg-buzz/60"></div>
                {/if}
              </div>
              <div class="mt-2 font-mono text-xs text-dark-2">{r.progress}</div>
              {#if r.sampleUrls.length > 0 && r.media !== 'audio'}
                <div class="mt-3"><SampleGrid urls={r.sampleUrls} cols={4} isVideo={r.isVideo} /></div>
              {/if}
            {:else if r.state === 'failed'}
              <div
                class="flex items-center gap-2 rounded-md border border-red-500/20 bg-red-500/5 px-3 py-4 text-xs text-dark-2"
              >
                <IconAlertTriangle size={15} stroke={2} class="shrink-0 text-red-400" /> This run didn't complete.
              </div>
            {:else if r.sampleUrls.length > 0 && r.media !== 'audio'}
              <SampleGrid urls={r.sampleUrls} cols={4} isVideo={r.isVideo} />
            {:else}
              <div class="grid grid-cols-4 gap-1.5">
                {#each Array(4) as _, i (i)}
                  <GradientTile index={r.code.length + i} />
                {/each}
              </div>
            {/if}
          </div>

          <div class="relative z-[2] mt-auto flex flex-wrap gap-2 px-3.5 pb-3.5">
            {@render rowActions(r)}
          </div>
        </div>
      {/each}
    </div>
  {/if}
</section>

<AlertDialog.Root
  bind:open={
    () => deleteTarget !== null,
    (v) => {
      if (!v && !deleting) deleteTarget = null;
    }
  }
>
  <AlertDialog.Content portalProps={portalProps()}>
    <AlertDialog.Header>
      <AlertDialog.Title>Delete this training?</AlertDialog.Title>
      <AlertDialog.Description>
        <span class="font-semibold text-dark-0">{deleteTarget?.name}</span> and its checkpoints and
        samples leave your trainings. This can't be undone.
      </AlertDialog.Description>
    </AlertDialog.Header>
    {#if deleteError}
      <p class="m-0 font-mono text-xs text-red-400">{deleteError}</p>
    {/if}
    <AlertDialog.Footer>
      <AlertDialog.Cancel disabled={deleting}>Cancel</AlertDialog.Cancel>
      <Button variant="destructive" disabled={deleting} onclick={confirmDelete}>
        {deleting ? 'Deleting…' : 'Delete'}
      </Button>
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>
