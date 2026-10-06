<script lang="ts">
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { LINK_CLASS, plural } from '$lib/format';
  import { caseSourceHref, caseTitle } from '$lib/text-scan-lab/case-view';
  import { LABEL_NAMES } from '$lib/text-scan-lab/labels';
  import { asExpectedText, type CaseChange, type SideScore } from '$lib/text-scan-lab/run-summary';
  import type { SetRunSide, SetRunView } from './+page.server';

  let {
    view,
    changedError,
    changedTitle,
    changesName,
    civitaiUrl,
    busy,
    onload,
    onrerun,
  }: {
    view: SetRunView;
    changedError: string | null;
    changedTitle: string;
    changesName: string;
    civitaiUrl: string;
    busy: boolean;
    onload: (caseId: number) => void;
    onrerun: (runId: number) => void;
  } = $props();

  const columns = $derived([
    { title: 'Current', side: view.current, key: 'current' as const },
    ...(view.changed ? [{ title: changedTitle, side: view.changed, key: 'changed' as const }] : []),
  ]);
  const historyHref = $derived(
    view.changed
      ? `/text-scan/test-sets/${view.setId}?a=${view.current.runId}&b=${view.changed.runId}`
      : `/text-scan/test-sets/${view.setId}`
  );
  const score = (s: SideScore | null) => (s ? asExpectedText(s) : 'not scored');
  const caseName = (caseId: number) => {
    const c = view.cases[caseId];
    return c ? caseTitle(c.entityType, c.entityId) : 'A removed case';
  };
</script>

{#snippet sourceLink(caseId: number)}
  {@const c = view.cases[caseId]}
  {@const href = c ? caseSourceHref(civitaiUrl, c.entityType, c.entityId) : null}
  {#if href}
    <a {href} target="_blank" rel="noopener" class="text-xs {LINK_CLASS}">open source</a>
  {/if}
{/snippet}

{#snippet changeList(title: string, changes: CaseChange[], tone: string)}
  <div class="min-w-0">
    <h4 class="text-xs font-semibold uppercase tracking-wide {tone}">{title}</h4>
    {#if changes.length}
      <ul class="mt-2 max-h-96 space-y-2 overflow-y-auto">
        {#each changes as change (`${change.caseId}-${change.label}`)}
          <li class="rounded-lg border border-dark-4 bg-dark-7 p-3">
            <div class="flex items-baseline justify-between gap-2">
              <button
                type="button"
                class="text-left text-sm {LINK_CLASS}"
                disabled={busy}
                onclick={() => onload(change.caseId)}
              >
                {caseName(change.caseId)}
              </button>
              {@render sourceLink(change.caseId)}
            </div>
            {#if view.cases[change.caseId]?.preview}
              <p class="mt-1 break-words text-xs text-dark-0">{view.cases[change.caseId].preview}</p>
            {/if}
            <p class="mt-1 text-xs text-dark-2">
              {LABEL_NAMES[change.label]}: expected {change.expected} — now {change.changed}, was
              {change.current}
            </p>
          </li>
        {/each}
      </ul>
    {:else}
      <p class="mt-2 text-xs text-dark-2">None.</p>
    {/if}
  </div>
{/snippet}

{#snippet errorList(title: string, side: SetRunSide)}
  {#if side.errors.length}
    <details class="mt-2">
      <summary class="cursor-pointer text-sm text-red-300">
        {title}: {plural(side.errors.length, 'case')} could not be judged
      </summary>
      <ul class="mt-2 max-h-48 space-y-1 overflow-y-auto text-xs">
        {#each side.errors as e (e.caseId)}
          <li>
            <button type="button" class={LINK_CLASS} disabled={busy} onclick={() => onload(e.caseId)}>
              {caseName(e.caseId)}
            </button>:
            <span class="whitespace-pre-wrap break-words text-dark-0">{e.error}</span>
          </li>
        {/each}
      </ul>
    </details>
  {/if}
  {#if side.errors.length || side.status === 'interrupted'}
    <Button
      class="mt-2"
      size="sm"
      variant="outline"
      disabled={busy}
      onclick={() => onrerun(side.runId)}
    >
      {side.status === 'interrupted'
        ? 'Finish the run'
        : `Re-run ${plural(side.errors.length, 'error')}`}
    </Button>
  {/if}
{/snippet}

<div class="mt-4 space-y-4 border-t border-dark-4 pt-4">
  <div class="flex flex-wrap items-baseline justify-between gap-2">
    <h3 class="text-sm font-semibold text-white">Set results</h3>
    <a href={historyHref} class="text-xs {LINK_CLASS}">See on Test sets</a>
  </div>

  <div class="grid gap-3 sm:grid-cols-2">
    {#each columns as column (column.title)}
      <div class="rounded-lg border border-dark-4 bg-dark-7 p-4">
        <p class="text-xs text-dark-2">{column.title}</p>
        {#if column.side.status === 'failed'}
          <p class="mt-1 text-sm text-red-300">
            This run failed — <a href="/text-scan/test-sets/{view.setId}" class={LINK_CLASS}>see it on
              Test sets</a>.
          </p>
        {:else if column.side.status === 'interrupted'}
          <p class="mt-1 text-sm text-red-300">
            This run was interrupted. Finish it below, or run the set again.
          </p>
        {/if}
        <ul class="mt-1 space-y-1 text-sm text-dark-0">
          {#each view.summary.labels as l (l.label)}
            <li><span class="text-white">{l.name}:</span> {score(l[column.key])}</li>
          {:else}
            <li class="text-dark-2">Nothing was scored.</li>
          {/each}
        </ul>
        {@render errorList(column.title, column.side)}
      </div>
    {/each}
  </div>

  {#if changedError}
    <p class="whitespace-pre-wrap text-sm text-red-300">
      {changedTitle} did not run: {changedError}
    </p>
  {/if}

  {#if view.changed}
    <p class="text-sm text-white">
      {changesName} fixed {view.summary.fixed.length} · broke {view.summary.broke.length}
    </p>
    <div class="grid gap-4 lg:grid-cols-2">
      {@render changeList('Fixed', view.summary.fixed, 'text-green-300')}
      {@render changeList('Broke', view.summary.broke, 'text-red-300')}
    </div>
  {/if}
</div>
