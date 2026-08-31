<script lang="ts">
  import type { ActionData, PageData } from './$types';
  import { FormState } from '$lib/form-state.svelte';
  import QueuePanel from './QueuePanel.svelte';
  import PostPanel from './PostPanel.svelte';
  import HistoryPanel from './HistoryPanel.svelte';
  import { Tabs, TabsList, TabsTrigger } from '@civitai/ui/components/ui/tabs/index.js';
  import { num } from '$lib/format';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  // Deliberately NOT in the URL. Every other bit of state on this page is a query param because it
  // changes what `load` fetches; this only chooses which of two already-loaded lists is on screen,
  // and putting it in the URL would add a param to every link a moderator shares.
  let queueView = $state<'open' | 'resolved'>('open');
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

<!-- The page owns its height, and the header lives in the RIGHT pane rather than above both. That is
     not cosmetic: a header above the row pushed the queue 136px down the viewport, and since CSS
     cannot read its own offset, no height on the queue could then be correct. With the row as the
     page root the queue starts at the top of the content region and its height is simply the row. -->
<div class="flex flex-col gap-4 px-6 pb-6 xl:h-[calc(100svh-3rem)] xl:flex-row xl:items-stretch">
    <!-- Only the row list inside the panel scrolls, so its heading, filters and pager stay reachable
         without scrolling fifty rows first. -->
    <div class="flex min-h-0 min-w-0 flex-col gap-2 xl:h-full xl:w-96 xl:shrink-0">
      <Tabs value={queueView} onValueChange={(v) => v && (queueView = v as typeof queueView)}>
        <TabsList>
          <TabsTrigger value="open">Open ({num(data.queueTotal)})</TabsTrigger>
          <TabsTrigger value="resolved">
            Resolved ({num(data.history.length)}{data.historyTruncated ? "+" : ""})
          </TabsTrigger>
        </TabsList>
      </Tabs>
      {#if queueView === 'open'}
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
      {:else}
        <HistoryPanel history={data.history} truncated={data.historyTruncated} />
      {/if}
    </div>

    <div class="min-w-0 flex-1 xl:h-full xl:overflow-y-auto">
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
