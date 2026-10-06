<script lang="ts">
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import * as Table from '@civitai/ui/components/ui/table/index.js';
  import { LINK_CLASS, plural } from '$lib/format';
  import AddEntitiesForm from './AddEntitiesForm.svelte';
  import CaseRow from './CaseRow.svelte';

  let { data } = $props();
  const canEdit = $derived(!!data.grants['textScan.testSet.edit'] && !data.set.archivedAt);
</script>

<svelte:head><title>{data.set.name} · Text-scan test sets</title></svelte:head>

<a href="/text-scan/test-sets" class="text-sm {LINK_CLASS}">← Test sets</a>
<div class="mb-4 mt-2">
  <h1 class="text-xl font-semibold text-white">
    {data.set.name}
    {#if data.set.archivedAt}
      <Badge variant="outline" class="ml-2 align-middle">archived</Badge>
    {/if}
  </h1>
  {#if data.set.description}
    <p class="mt-1 text-sm text-dark-2">{data.set.description}</p>
  {/if}
</div>

{#if canEdit}
  <AddEntitiesForm maxIds={data.maxAddEntities} />
{/if}

<section class="rounded-xl border border-dark-4 bg-dark-6 p-5">
  <h2 class="mb-2 text-sm font-semibold text-white">{plural(data.cases.length, 'case')}</h2>
  {#if data.cases.length}
    <Table.Root>
      <Table.Header>
        <Table.Row>
          <Table.Head>Source</Table.Head>
          <Table.Head>Text</Table.Head>
          <Table.Head>Expected</Table.Head>
          {#if canEdit}<Table.Head></Table.Head>{/if}
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {#each data.cases as testCase (testCase.id)}
          <CaseRow {testCase} civitaiUrl={data.civitaiUrl} {canEdit} />
        {/each}
      </Table.Body>
    </Table.Root>
  {:else}
    <p class="text-sm text-dark-2">
      No cases yet.{canEdit ? ' Add entities above, or save one from the playground.' : ''}
    </p>
  {/if}
</section>
