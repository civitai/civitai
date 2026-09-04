<script lang="ts">
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import AllowanceNotice from './AllowanceNotice.svelte';
  import AnnouncementComposer from './AnnouncementComposer.svelte';
  import AnnouncementList from './AnnouncementList.svelte';
  import AnnouncementMetricsNotice from './AnnouncementMetricsNotice.svelte';
  import MutesPanel from './MutesPanel.svelte';
  import type { AnnouncementRow } from '$lib/server/announcements';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  // The id, not the row: a save invalidates `data`, and holding the old object would keep the
  // composer editing a snapshot that no longer matches what is stored.
  let editingId = $state<number | null>(null);
  let composing = $state(false);

  const editing = $derived(data.announcements.find((a) => a.id === editingId) ?? null);
  // A row deleted while its editor is open would otherwise leave the composer in create mode with
  // the same content, so Save would post a second announcement and spend another slot.
  const lost = $derived(editingId !== null && editing === null);
  const open = $derived(!lost && (composing || editing !== null));

  function startNew() {
    editingId = null;
    composing = true;
  }

  function startEdit(announcement: AnnouncementRow) {
    editingId = announcement.id;
    composing = true;
  }

  function close() {
    editingId = null;
    composing = false;
  }
</script>

<svelte:head><title>Announcements · Creator Studio</title></svelte:head>

<div class="flex flex-col gap-5">
  <div class="flex flex-wrap items-center justify-between gap-3">
    <header class="page-header !mb-0">
      <h1>Announcements</h1>
      <p>Tell your followers what you are working on.</p>
    </header>
    {#if !open}
      <Button onclick={startNew}>New announcement</Button>
    {/if}
  </div>

  <AllowanceNotice allowance={data.allowance} error={data.allowanceError} />

  <AnnouncementMetricsNotice unavailable={data.metrics === null} />

  {#if open}
    {#key editingId ?? 'new'}
      <AnnouncementComposer
        announcement={editing}
        allowance={data.allowance}
        error={form?.scope === 'save' && form.subject === editingId ? (form.error ?? null) : null}
        onDone={close}
      />
    {/key}
  {/if}

  {#if data.metrics}
    <MutesPanel mutedNow={data.metrics.mutedNow} series={data.metrics.muteSeries} />
  {/if}

  <AnnouncementList
    announcements={data.announcements}
    metrics={data.metrics}
    deleteError={form?.scope === 'delete'
      ? { id: form.subject ?? null, message: form.error ?? '' }
      : null}
    onEdit={startEdit}
  />
</div>
