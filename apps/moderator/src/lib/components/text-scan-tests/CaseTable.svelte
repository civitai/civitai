<script lang="ts">
  import { enhance } from '$app/forms';
  import { Checkbox } from '@civitai/ui/components/ui/checkbox/index.js';
  import { Label } from '@civitai/ui/components/ui/label/index.js';
  import * as Select from '@civitai/ui/components/ui/select/index.js';
  import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
  } from '@civitai/ui/components/ui/table/index.js';
  import { FormState } from '$lib/form-state.svelte';
  import { dateTime } from '$lib/format';
  import type { CaseListRow } from '$lib/server/text-scan-tests/reports';
  import { ENTITY_TYPE_NAMES, LABEL_NAMES } from '$lib/text-scan-lab/labels';
  import type { LabEntityType, LabLabel } from '$lib/text-scan-lab/types';
  import { LABEL_ORDER, scoredLabels } from '$lib/text-scan-tests/expected';
  import ConfirmButton from '$lib/components/ConfirmButton.svelte';

  let {
    setId,
    cases,
    editable,
  }: { setId: number; cases: CaseListRow[]; editable: boolean } = $props();

  const ALL = 'all';
  let typeFilter = $state(ALL);
  let labelFilter = $state(ALL);
  let wipedOnly = $state(false);

  const entityTypes = $derived([...new Set(cases.map((c) => c.entityType))].sort());
  const visible = $derived(
    cases.filter(
      (c) =>
        (typeFilter === ALL || c.entityType === typeFilter) &&
        (labelFilter === ALL || scoredLabels(c.expected).includes(labelFilter as LabLabel)) &&
        (!wipedOnly || c.sourceDeletedAt !== null)
    )
  );

  const remove = new FormState({ reset: false, reload: true, onSuccess: null });
</script>

<section class="space-y-3">
  <div class="flex flex-wrap items-center gap-3">
    <h2 class="text-sm font-semibold text-white">
      Cases ({visible.length} of {cases.length})
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
    <div class="flex items-center gap-2">
      <Checkbox
        id="cases-wiped-only"
        bind:checked={() => wipedOnly, (v) => (wipedOnly = v)}
      />
      <Label for="cases-wiped-only" class="text-xs font-normal text-dark-2">
        Text removed only
      </Label>
    </div>
  </div>
  {#if remove.error}<p class="text-sm text-red-300">{remove.error}</p>{/if}
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
                  <input type="hidden" name="setId" value={setId} />
                  <input type="hidden" name="caseId" value={c.id} />
                  <ConfirmButton
                    label="Remove"
                    size="xs"
                    title="Remove case {c.id}?"
                    description="Its results in every run go with it."
                    disabled={remove.submitting}
                  />
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
