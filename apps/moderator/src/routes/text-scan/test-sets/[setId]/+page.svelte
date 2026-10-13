<script lang="ts">
  import { enhance } from '$app/forms';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
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
  import HistoryChart from '$lib/components/text-scan-tests/HistoryChart.svelte';
  import { FormState } from '$lib/form-state.svelte';
  import { LINK_CLASS, dateTime } from '$lib/format';
  import { ENTITY_TYPE_NAMES, LABEL_NAMES } from '$lib/text-scan-lab/labels';
  import type { LabEntityType, LabLabel } from '$lib/text-scan-lab/types';
  import { LABEL_ORDER, scoredLabels } from '$lib/text-scan-tests/expected';
  import { RUN_KIND_NAMES, WORKSPACE_NAMES, WORKSPACE_PATHS } from '$lib/text-scan-tests/types';

  let { data } = $props();

  const ALL = 'all';
  let typeFilter = $state(ALL);
  let labelFilter = $state(ALL);
  let wipedOnly = $state(false);

  const editable = $derived(data.canEdit && !data.set.archivedAt);
  const entityTypes = $derived([...new Set(data.cases.map((c) => c.entityType))].sort());
  const visible = $derived(
    data.cases.filter(
      (c) =>
        (typeFilter === ALL || c.entityType === typeFilter) &&
        (labelFilter === ALL || scoredLabels(c.expected).includes(labelFilter as LabLabel)) &&
        (!wipedOnly || c.sourceDeletedAt !== null)
    )
  );

  const remove = new FormState({ reset: false, reload: true, onSuccess: null });
  const archive = new FormState({ reset: false, reload: true, onSuccess: null });

  const confirmFirst = (message: string) => (e: MouseEvent) => {
    if (!confirm(message)) e.preventDefault();
  };
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
      <Button
        type="submit"
        size="sm"
        variant="ghost"
        disabled={archive.submitting}
        onclick={confirmFirst('Archive this set? Its runs stay readable.')}
      >
        Archive set
      </Button>
    </form>
  {/if}
</div>
{#if archive.error || remove.error}
  <p class="mb-3 text-sm text-red-300">{archive.error ?? remove.error}</p>
{/if}

<div class="space-y-6">
  <HistoryChart points={data.history} />

  <section class="space-y-3">
    <div class="flex flex-wrap items-center gap-3">
      <h2 class="text-sm font-semibold text-white">
        Cases ({visible.length} of {data.cases.length})
      </h2>
      <Select.Root type="single" bind:value={typeFilter}>
        <Select.Trigger class="w-44" aria-label="Filter by entity type">
          {typeFilter === ALL ? 'All entity types' : ENTITY_TYPE_NAMES[typeFilter as LabEntityType]}
        </Select.Trigger>
        <Select.Content>
          <Select.Item value={ALL}>All entity types</Select.Item>
          {#each entityTypes as type (type)}
            <Select.Item value={type}>{ENTITY_TYPE_NAMES[type]}</Select.Item>
          {/each}
        </Select.Content>
      </Select.Root>
      <Select.Root type="single" bind:value={labelFilter}>
        <Select.Trigger class="w-40" aria-label="Filter by label">
          {labelFilter === ALL ? 'All labels' : LABEL_NAMES[labelFilter as LabLabel]}
        </Select.Trigger>
        <Select.Content>
          <Select.Item value={ALL}>All labels</Select.Item>
          {#each LABEL_ORDER as label (label)}
            <Select.Item value={label}>{LABEL_NAMES[label]}</Select.Item>
          {/each}
        </Select.Content>
      </Select.Root>
      <label class="flex items-center gap-2 text-xs text-dark-2">
        <input type="checkbox" bind:checked={wipedOnly} /> Text removed only
      </label>
    </div>
    <div class="rounded-xl border border-dark-4 bg-dark-6">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Case</TableHead>
            <TableHead>Text</TableHead>
            <TableHead>Scores</TableHead>
            <TableHead>Added</TableHead>
            {#if editable}<TableHead><span class="sr-only">Actions</span></TableHead>{/if}
          </TableRow>
        </TableHeader>
        <TableBody>
          {#each visible as c (c.id)}
            <TableRow>
              <TableCell class="align-top text-sm text-dark-0">
                #{c.id} · {ENTITY_TYPE_NAMES[c.entityType]}{c.entityId !== null
                  ? ` ${c.entityId}`
                  : ''}
              </TableCell>
              <TableCell class="max-w-96 whitespace-normal break-words align-top text-xs text-dark-2">
                {c.preview ?? 'Text removed'}
              </TableCell>
              <TableCell class="align-top text-xs text-dark-0">
                {scoredLabels(c.expected)
                  .map((l) => LABEL_NAMES[l])
                  .join(', ') || 'nothing'}
              </TableCell>
              <TableCell class="align-top text-xs text-dark-2">
                {dateTime(c.addedAt)} · {c.origin}
              </TableCell>
              {#if editable}
                <TableCell class="align-top">
                  <form method="POST" action="?/removeCase" use:enhance={remove.enhance}>
                    <input type="hidden" name="setId" value={data.set.id} />
                    <input type="hidden" name="caseId" value={c.id} />
                    <Button
                      type="submit"
                      size="xs"
                      variant="ghost"
                      disabled={remove.submitting}
                      onclick={confirmFirst(`Remove case ${c.id} and its results?`)}
                    >
                      Remove
                    </Button>
                  </form>
                </TableCell>
              {/if}
            </TableRow>
          {:else}
            <TableRow>
              <TableCell class="text-sm text-dark-2">No cases match.</TableCell>
            </TableRow>
          {/each}
        </TableBody>
      </Table>
    </div>
    <p class="text-xs text-dark-2">
      Edit a case's expectation from a run's results, where both verdicts are shown.
    </p>
  </section>

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
