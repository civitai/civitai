<script lang="ts">
  import { IconAlertTriangle, IconLayoutGrid, IconList, IconPlus } from '@tabler/icons-svelte';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
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
  import { browser, hrefFor } from '$lib/host';
  import { locationHref } from '$lib/actions/locationHref';
  import { remixFromRun } from '$lib/reuse';
  import RunStateBadge from '$lib/components/RunStateBadge.svelte';
  import SampleGrid from '$lib/components/SampleGrid.svelte';
  import GradientTile from '$lib/components/GradientTile.svelte';
  import type { TrainingRow } from '$lib/data/trainingRows';

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
</script>

{#snippet remixButton(r: TrainingRow)}
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

  {#if remixError}
    <p
      class="rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 font-mono text-xs text-red-400"
    >
      {remixError}
    </p>
  {/if}

  {#if rows.length === 0}
    <div class="rounded-xl border border-dashed border-dark-4 bg-dark-6 p-10 text-center">
      <p class="text-sm text-dark-2">No trainings yet.</p>
      <Button class="mt-3" onclick={onNew}>
        <IconPlus size={15} stroke={2} class="mr-1.5 inline" />Start your first training
      </Button>
    </div>
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
          {#each rows as r (r.workflowId ?? r.name)}
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
              <TableCell class="max-w-[32ch] truncate px-4 py-2.5 font-mono text-xs text-dark-2">
                {#if r.state === 'training'}
                  {r.progressPct > 0 ? `${r.progressPct}% · ` : ''}{r.progress}
                {:else}
                  {r.sub}
                {/if}
              </TableCell>
              <TableCell class="whitespace-nowrap px-4 py-2.5 text-right">
                {@render remixButton(r)}
              </TableCell>
            </TableRow>
          {/each}
        </TableBody>
      </Table>
    </div>
  {:else}
    <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {#each rows as r (r.workflowId ?? r.name)}
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
            <div class="mt-0.5 truncate font-mono text-xs text-dark-2">
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
            {@render remixButton(r)}
          </div>
        </div>
      {/each}
    </div>
  {/if}
</section>
