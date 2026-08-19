<script lang="ts">
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import AllowanceNotice from './AllowanceNotice.svelte';
  import AnnouncementComposer from './AnnouncementComposer.svelte';
  import AnnouncementList from './AnnouncementList.svelte';
  import type { AnnouncementRow } from '$lib/server/announcements';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  let editing = $state<AnnouncementRow | null>(null);
  let composing = $state(false);

  const open = $derived(composing || editing !== null);

  function startNew() {
    editing = null;
    composing = true;
  }

  function startEdit(announcement: AnnouncementRow) {
    editing = announcement;
    composing = true;
  }

  function close() {
    editing = null;
    composing = false;
  }
</script>

<svelte:head><title>Announcements · Creator Studio</title></svelte:head>

<div class="flex flex-col gap-5">
  <div class="flex flex-wrap items-center justify-between gap-3">
    <div>
      <h1 class="text-xl font-semibold text-white">Announcements</h1>
      <p class="text-sm text-dark-2">Tell your followers what you are working on.</p>
    </div>
    {#if !open}
      <Button onclick={startNew}>New announcement</Button>
    {/if}
  </div>

  <AllowanceNotice allowance={data.allowance} error={data.allowanceError} />

  {#if open}
    {#key editing?.id ?? 'new'}
      <AnnouncementComposer
        announcement={editing}
        allowance={data.allowance}
        error={form?.scope === 'save' ? (form.error ?? null) : null}
        onDone={close}
      />
    {/key}
  {/if}

  <AnnouncementList
    announcements={data.announcements}
    error={form?.scope === 'delete' ? (form.error ?? null) : null}
    onEdit={startEdit}
  />
</div>
