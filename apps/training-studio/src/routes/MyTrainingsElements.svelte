<script lang="ts">
  import type { Snippet } from 'svelte';
  import { SvelteSet } from 'svelte/reactivity';
  import {
    IconAlertTriangle,
    IconDotsVertical,
    IconHourglass,
    IconMusic,
    IconPhoto,
    IconPlus,
    IconRefresh,
    IconTrash,
  } from '@tabler/icons-svelte';
  import '$lib/civitai-elements';
  import type { CivitaiSegmentedControl } from '@civitai/components/civitai-segmented-control';
  import type { CivitaiSelect } from '@civitai/components/civitai-select';
  import { backend, browser, hrefFor } from '$lib/host';
  import { locationHref } from '$lib/actions/locationHref';
  import { TRAINING_REVIEW_COPY } from '@civitai/shared/training-review';
  import { remixFromRun } from '$lib/reuse';
  import { submitNotice } from '$lib/submit-notice.svelte';
  import RunStateBadge from '$lib/components/RunStateBadge.svelte';
  import ServiceStatusBanner from '$lib/components/ServiceStatusBanner.svelte';
  import { grad } from '$lib/components/GradientTile.svelte';
  import { playOnHover, resetOnLeave } from '$lib/video-preview';
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
  const placeholderIndex = (r: TrainingRow) =>
    [...(r.workflowId ?? r.name)].reduce((sum, ch) => sum + ch.charCodeAt(0), 0);
  const remixLabel = (r: TrainingRow) => (r.state === 'failed' ? 'Retry' : 'Remix');
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
  // civitai-select marks its option with the `selected` attribute only, which a browser ignores once
  // the user has picked from that select; remounting the selects is what shows a cleared filter.
  let filterResets = $state(0);
  function clearFilters() {
    baseFilter = ALL;
    stateFilter = ALL;
    filterResets += 1;
  }
</script>

{#snippet rowActions(r: TrainingRow)}
  <!-- Disabled whenever a click would silently no-op: no workflow to remix, or ANY remix already
       in flight (remix() early-returns then) — "the button never looks like a dead click". -->
  <civitai-button
    variant="outline"
    size="sm"
    loading={remixingId === r.workflowId}
    disabled={!r.workflowId || remixingId !== null}
    onclick={() => r.workflowId && remix(r.workflowId)}
  >
    {remixLabel(r)}
  </civitai-button>
  {#if r.workflowId && canDeleteRun(r)}
    <studio-icon-button label={`Delete ${r.name}`} color="error" onclick={() => askDelete(r)}>
      <IconTrash size={16} stroke={2} />
    </studio-icon-button>
  {:else}
    <!-- Keeps the Remix buttons in one column whether or not the row can be deleted. -->
    <span class="inline-block size-7" aria-hidden="true"></span>
  {/if}
{/snippet}

{#snippet cardCover(r: TrainingRow)}
  {#if r.sampleUrls.length > 0 && r.media !== 'audio'}
    {@const shown = r.sampleUrls.slice(0, 4)}
    <div class="grid size-full gap-0.5 bg-dark-8 {shown.length > 1 ? 'grid-cols-2 grid-rows-2' : ''}">
      {#each shown as url, i (i)}
        {#if r.isVideo}
          <video
            src={url}
            muted
            loop
            playsinline
            preload="metadata"
            aria-hidden="true"
            class="size-full min-h-0 object-cover"
            onmouseenter={playOnHover}
            onmouseleave={resetOnLeave}
          ></video>
        {:else}
          <img src={url} alt="" loading="lazy" class="size-full min-h-0 object-cover" />
        {/if}
      {/each}
      {#each Array(shown.length > 1 ? 4 - shown.length : 0) as _, i (i)}
        <div class="bg-dark-7"></div>
      {/each}
    </div>
  {:else}
    <div class="grid size-full place-items-center" style={`background:${grad(placeholderIndex(r))}`}>
      {#if r.state === 'failed'}
        <IconAlertTriangle size={40} stroke={1.5} class="text-white/50" />
      {:else if r.state === 'review' || r.state === 'rejected' || r.state === 'unreviewed'}
        <IconHourglass size={40} stroke={1.5} class="text-white/50" />
      {:else if r.media === 'audio'}
        <IconMusic size={40} stroke={1.5} class="text-white/50" />
      {:else}
        <IconPhoto size={40} stroke={1.5} class="text-white/50" />
      {/if}
    </div>
  {/if}
{/snippet}

{#snippet emptyState(message: string, action: Snippet)}
  <div class="rounded-xl border border-dashed border-dark-4 bg-dark-6 p-10 text-center">
    <p class="text-sm text-dark-2">{message}</p>
    {@render action()}
  </div>
{/snippet}

<section class="flex flex-col gap-5">
  <ServiceStatusBanner />
  <div class="flex flex-wrap items-center justify-between gap-3">
    <div>
      <h2 class="m-0 text-xl font-semibold text-white">My trainings</h2>
      <p class="mt-1 text-sm text-dark-2">
        Runs stay here for 30 days. Publish one and the model lives on Civitai for good, though the run
        itself still leaves this list.
      </p>
    </div>
    <div class="flex items-center gap-2">
      <civitai-segmented-control
        size="sm"
        data={[
          { value: 'cards', label: 'Cards' },
          { value: 'list', label: 'List' },
        ]}
        value={view}
        onchange={(e: Event) => {
          const v = (e.currentTarget as CivitaiSegmentedControl).value;
          if (v === 'cards' || v === 'list') setView(v);
        }}
      ></civitai-segmented-control>
      <civitai-button onclick={onNew}>
        <span slot="left"><IconPlus size={15} stroke={2} /></span>New training
      </civitai-button>
    </div>
  </div>

  {#if submitNotice.message}
    <civitai-alert
      role="alert"
      color="error"
      closable
      close-label="Dismiss"
      onclose={() => submitNotice.clear()}
    >
      {submitNotice.message}
    </civitai-alert>
  {/if}

  {#if remixError}
    <civitai-alert role="alert" color="error">{remixError}</civitai-alert>
  {/if}

  {#if liveRows.length > 0}
    <div class="flex flex-wrap items-end gap-3">
      {#key filterResets}
      <civitai-select
        class="w-48"
        size="sm"
        label="Base model"
        data={[{ value: ALL, label: 'All base models' }, ...baseOptions.map((b) => ({ value: b, label: b }))]}
        value={activeBase}
        onchange={(e: Event) => (baseFilter = (e.currentTarget as CivitaiSelect).value)}
      ></civitai-select>
      <civitai-select
        class="w-40"
        size="sm"
        label="Status"
        data={[
          { value: ALL, label: 'All statuses' },
          ...stateOptions.map((st) => ({ value: st, label: RUN_STATE_BADGE[st].label })),
        ]}
        value={activeState}
        onchange={(e: Event) => (stateFilter = (e.currentTarget as CivitaiSelect).value)}
      ></civitai-select>
      {/key}
      {#if filtered}
        <civitai-button variant="subtle" size="sm" onclick={clearFilters}>Clear filters</civitai-button>
        <span class="font-mono text-xs text-dark-2">
          {visibleRows.length} of {liveRows.length}
        </span>
      {/if}
    </div>
  {/if}

  {#if liveRows.length === 0}
    {#snippet startFirst()}
      <civitai-button class="mt-3" onclick={onNew}>
        <span slot="left"><IconPlus size={15} stroke={2} /></span>Start your first training
      </civitai-button>
    {/snippet}
    {@render emptyState('No trainings yet.', startFirst)}
  {:else if visibleRows.length === 0}
    {#snippet clearAction()}
      <civitai-button class="mt-3" variant="outline" onclick={clearFilters}>Clear filters</civitai-button>
    {/snippet}
    {@render emptyState('No trainings match these filters.', clearAction)}
  {:else if view === 'list'}
    <div class="overflow-hidden rounded-xl border border-dark-4 bg-dark-6">
      <civitai-table hoverable>
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Base</th>
              <th>Status</th>
              <th>Progress</th>
              <th class="text-right"><span class="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {#each visibleRows as r (r.workflowId ?? r.name)}
              <tr>
                <td class="max-w-[24ch] truncate font-semibold text-dark-0">
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
                </td>
                <td class="whitespace-nowrap">
                  <span class="font-mono text-xs text-dark-2">{r.base}</span>
                </td>
                <td><RunStateBadge state={r.state} /></td>
                <td class="max-w-[32ch] whitespace-normal font-mono text-xs text-dark-2">
                  {#if r.state === 'training'}
                    {r.progressPct > 0 ? `${r.progressPct}% · ` : ''}{r.progress}
                  {:else}
                    {r.sub}
                  {/if}
                </td>
                <td class="whitespace-nowrap text-right">
                  <span class="inline-flex items-center gap-2">{@render rowActions(r)}</span>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </civitai-table>
    </div>
  {:else}
    <div class="grid grid-cols-[repeat(auto-fill,minmax(232px,1fr))] gap-4">
      {#each visibleRows as r (r.workflowId ?? r.name)}
        {@const badge = RUN_STATE_BADGE[r.state]}
        <civitai-media-card
          class="group [--civitai-media-card-ratio:4/5] has-[a:focus-visible]:outline-2 has-[a:focus-visible]:outline-offset-2 has-[a:focus-visible]:outline-primary"
        >
          {#if r.workflowId}
            <a
              slot="media"
              href={hrefFor({ view: 'run', workflowId: r.workflowId })}
              use:locationHref={{ view: 'run', workflowId: r.workflowId }}
              aria-label={`Open ${r.name}`}
              class="block size-full overflow-hidden focus:outline-none"
            >
              {@render cardCover(r)}
            </a>
          {:else}
            <div slot="media" class="size-full overflow-hidden">{@render cardCover(r)}</div>
          {/if}

          <span
            slot="top-start"
            class="pointer-events-none inline-flex h-[26px] items-center gap-1.5 rounded-full bg-black/55 px-2.5 text-xs font-bold text-white backdrop-blur-sm"
          >
            <span class="size-1.5 rounded-full {badge.dot}"></span>{badge.label}
          </span>

          {#if r.workflowId}
            <civitai-menu
              slot="top-end"
              placement="bottom-end"
              label={`Actions for ${r.name}`}
              onselect={(e: CustomEvent<{ value: string }>) => {
                if (e.detail.value === 'remix') remix(r.workflowId!);
                else if (e.detail.value === 'delete') askDelete(r);
              }}
            >
              <studio-icon-button
                slot="trigger"
                size="lg"
                label={`More options for ${r.name}`}
                class="[--tone-hover:#fff] [--tone:#fff] drop-shadow-[0_1px_2px_rgb(0_0_0/0.7)]"
              >
                <IconDotsVertical size={22} stroke={2} />
              </studio-icon-button>
              <civitai-menu-item value="remix" disabled={remixingId !== null}>
                <span slot="icon"><IconRefresh size={16} stroke={2} /></span>{remixLabel(r)}
              </civitai-menu-item>
              {#if canDeleteRun(r)}
                <civitai-menu-item value="delete" destructive>
                  <span slot="icon"><IconTrash size={16} stroke={2} /></span>Delete
                </civitai-menu-item>
              {/if}
            </civitai-menu>
          {/if}

          <!-- Clicks fall through to the cover link; the text is a label, not a target. -->
          <div slot="bottom" class="pointer-events-none flex w-full min-w-0 flex-col gap-1">
            <div class="line-clamp-2 text-lg font-bold leading-tight text-white [text-shadow:1px_1px_1px_rgb(0_0_0/0.8)]">
              {r.name}
            </div>
            <div class="break-words text-xs text-white/80 [text-shadow:1px_1px_1px_rgb(0_0_0/0.8)]">
              <span class="font-semibold text-white">{r.base}</span>{r.sub ? ` · ${r.sub}` : ''}
            </div>
            {#if r.state === 'failed'}
              <div class="text-xs text-red-300">This run didn't complete.</div>
            {:else if r.state === 'review' || r.state === 'rejected' || r.state === 'unreviewed'}
              <div class="text-xs text-white/80">
                {r.state === 'review'
                  ? TRAINING_REVIEW_COPY.pendingTitle
                  : r.state === 'rejected'
                    ? TRAINING_REVIEW_COPY.notApprovedTitle
                    : TRAINING_REVIEW_COPY.unreviewedTitle}. Open the run for details.
              </div>
            {/if}
            {#if r.state === 'training'}
              <civitai-progress
                class="mt-1"
                aria-label="Training progress"
                size="sm"
                color="warning"
                value={r.progressPct}
                max={100}
                indeterminate={r.progressPct <= 0}
              ></civitai-progress>
              <div class="font-mono text-[11px] text-white/80">{r.progress}</div>
            {/if}
            {#if remixingId === r.workflowId}
              <div class="flex items-center gap-2 text-xs text-white">
                <civitai-loader size="sm"></civitai-loader>Preparing {remixLabel(r).toLowerCase()}…
              </div>
            {/if}
          </div>
        </civitai-media-card>
      {/each}
    </div>
  {/if}
</section>

<civitai-modal
  open={deleteTarget !== null}
  heading="Delete this training?"
  withCloseButton={!deleting}
  close-label="Cancel"
  closeOnEscape={!deleting}
  closeOnOverlayClick={!deleting}
  onclose={() => {
    if (!deleting) deleteTarget = null;
  }}
>
  <p class="m-0 text-sm text-dark-1">
    <span class="font-semibold text-dark-0">{deleteTarget?.name}</span> and its checkpoints and
    samples leave your trainings. This can't be undone.
  </p>
  {#if deleteError}
    <p class="m-0 mt-2 font-mono text-xs text-red-400">{deleteError}</p>
  {/if}
  <div class="mt-4 flex flex-wrap justify-end gap-2">
    <civitai-button variant="subtle" disabled={deleting} onclick={() => (deleteTarget = null)}>
      Cancel
    </civitai-button>
    <civitai-button color="error" loading={deleting} disabled={deleting} onclick={confirmDelete}>
      Delete
    </civitai-button>
  </div>
</civitai-modal>
