<script lang="ts">
  import { enhance } from '$app/forms';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import CaseTable from '$lib/components/text-scan-tests/CaseTable.svelte';
  import { ConfirmButton } from '@civitai/ui/components/confirm/index.js';
  import HistoryChart from '$lib/components/text-scan-tests/HistoryChart.svelte';
  import { FormState } from '$lib/form-state.svelte';
  import { LINK_CLASS, dateTime } from '$lib/format';
  import { RUN_KIND_NAMES, WORKSPACE_NAMES, WORKSPACE_PATHS } from '$lib/text-scan-tests/types';

  let { data } = $props();

  const editable = $derived(data.canEdit && !data.set.archivedAt);
  const archive = new FormState({ reset: false, reload: true, onSuccess: null });
  type Imported = { created: number; updated: number; notFound: number[] };
  let importRows = $state('');
  let imported = $state<Imported | null>(null);
  const importForm = new FormState({
    reset: false,
    reload: true,
    onSuccess: (result) => {
      imported = (result?.imported as Imported | undefined) ?? null;
      importRows = '';
    },
  });
</script>

<svelte:head><title>{data.set.name} · Test sets</title></svelte:head>

<div class="mb-4 flex flex-wrap items-baseline justify-between gap-2">
  <div>
    <h1 class="text-xl font-semibold text-white">{data.set.name}</h1>
    <p class="text-xs text-dark-2">
      Test set in
      <a href={WORKSPACE_PATHS[data.set.workspace]} class={LINK_CLASS}>
        {WORKSPACE_NAMES[data.set.workspace]}
      </a>
      · run it from the workspace's Test sets tab
      {#if data.set.archivedAt}· <Badge variant="secondary">Archived</Badge>{/if}
    </p>
    {#if data.set.description}<p class="mt-1 text-sm text-dark-0">{data.set.description}</p>{/if}
  </div>
  {#if editable}
    <form method="POST" action="?/archiveSet" use:enhance={archive.enhance}>
      <input type="hidden" name="setId" value={data.set.id} />
      <ConfirmButton
        label="Archive set"
        title="Archive this set?"
        description="Its runs stay readable; nothing can be added to it or run on it."
        disabled={archive.submitting}
      />
    </form>
  {/if}
</div>
{#if archive.error}<p class="mb-3 text-sm text-red-300">{archive.error}</p>{/if}

<div class="space-y-6">
  <HistoryChart points={data.history} />

  {#if data.isIntentSet}
    <section class="space-y-2">
      <h2 class="text-sm font-semibold text-white">Import models</h2>
      <p class="text-xs text-dark-2">
        This is the pinned set the civitai.com face intent prompt is tested on. Cases hold each
        model's listing as the live check reads it. Changing the set needs the intent publish
        permission.
      </p>
      {#if editable}
        <form method="POST" action="?/importIntent" use:enhance={importForm.enhance} class="space-y-2">
          <input type="hidden" name="setId" value={data.set.id} />
          <textarea
            name="rows"
            bind:value={importRows}
            rows="6"
            class="w-full rounded border border-dark-4 bg-dark-7 p-2 font-mono text-xs text-white"
            placeholder={'One model per line: <model id> detected|clear|unsure'}
            aria-label="Models to import"
          ></textarea>
          <button
            type="submit"
            class="rounded bg-blue-600 px-3 py-1 text-sm text-white disabled:opacity-50"
            disabled={importForm.submitting || !importRows.trim()}
          >
            Import
          </button>
        </form>
        {#if importForm.error}<p class="text-sm text-red-300">{importForm.error}</p>{/if}
        {#if imported}
          <p class="text-sm text-dark-0">
            {imported.created} added, {imported.updated} updated{#if imported.notFound.length}
              · not found: {imported.notFound.join(', ')}{/if}
          </p>
        {/if}
      {/if}
    </section>
  {/if}

  {#key data.set.id}
    <CaseTable setId={data.set.id} cases={data.cases} {editable} />
  {/key}

  <section class="space-y-2">
    <h2 class="text-sm font-semibold text-white">Runs</h2>
    <ul class="space-y-1">
      {#each data.runs as run (run.id)}
        <li class="text-sm">
          <a href="/text-scan/test-sets/{data.set.id}/runs/{run.id}" class={LINK_CLASS}>
            #{run.id} {RUN_KIND_NAMES[run.kind]} · {run.status}
          </a>
          <span class="text-xs text-dark-2">
            {dateTime(run.finishedAt ?? run.createdAt)} · {run.caseDone}/{run.caseTotal}
            {#if run.errorCount}· {run.errorCount} errors{/if}
          </span>
        </li>
      {:else}
        <li class="text-sm text-dark-2">No runs yet.</li>
      {/each}
    </ul>
  </section>
</div>
