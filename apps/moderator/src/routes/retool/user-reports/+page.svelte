<script lang="ts">
  import type { ActionData, PageData } from './$types';
  import { FormState } from '$lib/form-state.svelte';
  import QueuePanel from './QueuePanel.svelte';
  import SuspectPanel from './SuspectPanel.svelte';
  import HistoryPanel from './HistoryPanel.svelte';

  let { data, form }: { data: PageData; form: ActionData } = $props();
  // Which report row is in flight, so one claim does not disable all fifty rows.
  let pendingId = $state<number | null>(null);

  const scoped = (scope: string) =>
    form && 'scope' in form && form.scope === scope ? (form.error ?? null) : null;

  // Actioning a report or striking an account changes what the queue shows, and the queue comes from
  // `load` — so unlike the client-fetched panels elsewhere, this one does want the reload.
  // `onSubmit` reads the posted row, so the wrapper that existed only to peek at `formData` before
  // delegating is gone. `onSettled` clears the marker on refusal as well as success — it marks which
  // row is in flight, and a refused row that stays marked reads as still working.
  const onSubmit = new FormState({
    reload: true,
    onSuccess: null,
    onSubmit: ({ formData }) => (pendingId = Number(formData.get('id')) || null),
    onSettled: () => (pendingId = null),
  });
</script>

<header class="page-header">
  <h1>User Reports</h1>
  <p>
    Reports filed against accounts. Work one from the queue, review the account's content, and act
    without leaving the page.
  </p>
</header>

{#if !data.canAct}
  <p class="mb-4 text-sm text-dark-2">
    You can read this queue but not act on it. Actioning a report or striking an account requires the
    Users permission.
  </p>
{/if}

<!-- Queue left, selected account right. Stacked, the account landed below a 50-row queue and read as
     "nothing happened" when a report was clicked. -->
<div class="flex flex-col gap-4 xl:flex-row xl:items-start">
  <div
    class="min-w-0 xl:sticky xl:top-4 xl:max-h-[calc(100vh-2rem)] xl:w-96 xl:shrink-0 xl:overflow-y-auto"
  >
    <QueuePanel
      queue={data.queue}
      total={data.queueTotal}
      page={data.page}
      perPage={data.perPage}
      suspectId={data.suspectId}
      canAct={data.canAct}
      error={scoped('report')}
      onSubmit={onSubmit.enhance}
      {pendingId}
      queueFilters={data.queueFilters}
    />
  </div>

  <div class="min-w-0 flex-1">
    {#if data.suspectId && data.suspect && data.strikes}
      <!-- Keyed so an open strike or notify form cannot survive moving to a different suspect. -->
      {#key data.suspectId}
        <SuspectPanel
          suspectId={data.suspectId}
          suspect={data.suspect}
          filters={data.filters}
          strikes={data.strikes}
          legacyStrikeCount={data.legacyStrikeCount}
          modActivity={data.modActivity ?? []}
          reportsOnUser={data.reportsOnUser ?? []}
          notes={data.notes ?? []}
          canAct={data.canAct}
          civitaiUrl={data.civitaiUrl}
          strikeError={scoped('strike')}
          notifyError={scoped('notify')}
          imagesError={scoped('images')}
          imageResult={form && 'imageResult' in form ? (form.imageResult ?? null) : null}
        />
      {/key}
    {:else}
      <section class="rounded-xl border border-dashed border-dark-4 p-5">
        <p class="text-sm text-dark-2">
          Pick a reported account from the queue to see their images, strikes and enforcement options
          here.
        </p>
      </section>
    {/if}
  </div>
</div>

<HistoryPanel history={data.history} truncated={data.historyTruncated} />
