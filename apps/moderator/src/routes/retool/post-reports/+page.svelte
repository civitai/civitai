<script lang="ts">
  import type { ActionData, PageData } from './$types';
  import { FormState } from '$lib/form-state.svelte';
  import QueuePanel from './QueuePanel.svelte';
  import PostPanel from './PostPanel.svelte';
  import HistoryPanel from './HistoryPanel.svelte';

  let { data, form }: { data: PageData; form: ActionData } = $props();
  // Which report row is in flight, so one action does not disable all fifty rows.
  let pendingId = $state<number | null>(null);

  const scoped = (scope: string) =>
    form && 'scope' in form && form.scope === scope ? (form.error ?? null) : null;

  // Actioning a report or removing images changes what the queue shows, and the queue comes from
  // `load` — so unlike the client-fetched panels elsewhere, this one does want the reload.
  const onSubmit = new FormState({
    reload: true,
    onSuccess: null,
    onSubmit: ({ formData }) => (pendingId = Number(formData.get('id')) || null),
    onSettled: () => (pendingId = null),
  });
</script>

<header class="page-header">
  <h1>Post Reports</h1>
  <p>
    Reports filed against posts. Work one from the queue, review the post's images and the owner's
    history, and act without leaving the page.
  </p>
</header>

{#if !data.canAct}
  <p class="mb-4 text-sm text-dark-2">
    You can read this queue but not act on it. Actioning a report, removing images or striking an
    account requires the Users permission.
  </p>
{/if}

<!-- Queue left, selected post right. Stacked, the post landed below a 50-row queue and read as
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
      postId={data.postId}
      canAct={data.canAct}
      error={scoped('report')}
      onSubmit={onSubmit.enhance}
      {pendingId}
      queueFilters={data.queueFilters}
    />
  </div>

  <div class="min-w-0 flex-1">
    {#if data.postId && data.lookup && data.ownerId != null && data.accountHistory}
      <!-- Keyed so an open strike or notify form cannot survive moving to a different post. -->
      {#key data.postId}
        <PostPanel
          lookup={data.lookup}
          ownerId={data.ownerId}
          accountHistory={data.accountHistory}
          canAct={data.canAct}
          civitaiUrl={data.civitaiUrl}
          strikeError={scoped('strike')}
          notifyError={scoped('notify')}
          imagesError={scoped('images')}
          imageResult={form && 'imageResult' in form ? (form.imageResult ?? null) : null}
        />
      {/key}
    {:else if data.postId}
      <!-- A report outlives the post it is about, and the queue row says so too. Without this the
           panel would just be empty and read as a failed load. -->
      <section class="rounded-xl border border-dashed border-dark-4 p-5">
        <p class="text-sm text-dark-2">
          Post #{data.postId} no longer exists. The report can still be actioned or unactioned from the
          queue.
        </p>
      </section>
    {:else}
      <section class="rounded-xl border border-dashed border-dark-4 p-5">
        <p class="text-sm text-dark-2">
          Pick a reported post from the queue to see its images, the owner's history and the
          enforcement options here.
        </p>
      </section>
    {/if}
  </div>
</div>

<HistoryPanel history={data.history} truncated={data.historyTruncated} />
