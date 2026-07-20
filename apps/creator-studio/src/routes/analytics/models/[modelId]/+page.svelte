<script lang="ts">
  import { goto } from '$app/navigation';
  import * as Table from '@civitai/ui/components/ui/table/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { IconExternalLink, IconArrowLeft } from '@tabler/icons-svelte';
  import DeltaChip from '$lib/components/DeltaChip.svelte';
  import { formatRange } from '$lib/date-range';
  import { formatAmount, currencyMeta, currencySort, hasDisplayValue } from '$lib/earnings';
  import { modelUrl } from '$lib/model-url';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
  const num = (n: number) => n.toLocaleString();
  const periodLabel = $derived(`for ${formatRange(data.range)}`);

  const versions = $derived(data.model.versions);
  const currencies = $derived(
    [...new Set(versions.flatMap((v) => v.currencies.map((c) => c.currency)))].sort(currencySort)
  );
  const cell = (v: PageData['model']['versions'][number], currency: string) =>
    v.currencies.find((c) => c.currency === currency) ?? { currency, total: 0, prev: 0 };

  const civitaiUrl = $derived(modelUrl(data.model.modelId, data.model));

  let lookupId = $state('');
  function goToModel(e: Event) {
    e.preventDefault();
    const id = Number(lookupId);
    if (Number.isInteger(id) && id > 0) goto(`/analytics/models/${id}`);
  }
</script>

<div class="mb-4 flex flex-wrap items-start gap-3">
  <div>
    <a href="/analytics/models" class="mb-1 inline-flex items-center gap-1 text-xs text-dark-2 hover:text-white">
      <IconArrowLeft size={13} /> All models
    </a>
    <h2 class="flex items-center gap-2 text-xl font-semibold text-white">
      {data.model.modelName ?? `Model ${data.model.modelId}`}
      <a href={civitaiUrl} target="_blank" rel="noreferrer" class="text-dark-3 hover:text-white" aria-label="View on Civitai">
        <IconExternalLink size={16} />
      </a>
    </h2>
    <p class="text-sm text-dark-3">Per-version performance {periodLabel}.</p>
  </div>
  <form onsubmit={goToModel} class="ml-auto flex items-center gap-1">
    <input
      type="text"
      inputmode="numeric"
      bind:value={lookupId}
      placeholder="Model ID"
      class="w-24 rounded-lg border border-dark-4 bg-dark-6 px-2.5 py-1 text-sm text-white placeholder:text-dark-3"
    />
    <Button type="submit" size="sm" variant="secondary">View</Button>
  </form>
</div>

{#if versions.length === 0}
  <div class="placeholder">This model has no versions.</div>
{:else}
  <div class="rounded-lg border border-dark-4 bg-dark-6 p-4">
    <Table.Root>
      <Table.Header>
        <Table.Row>
          <Table.Head>Version</Table.Head>
          <Table.Head>Base model</Table.Head>
          <Table.Head class="text-right">Generations</Table.Head>
          <Table.Head class="text-right">Downloads</Table.Head>
          {#each currencies as c (c)}
            <Table.Head class="text-right">{currencyMeta(c).label}</Table.Head>
          {/each}
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {#each versions as v (v.versionId)}
          <Table.Row>
            <Table.Cell class="align-top text-dark-1">{v.versionName ?? `Version ${v.versionId}`}</Table.Cell>
            <Table.Cell class="align-top text-dark-2">{v.baseModel ?? '—'}</Table.Cell>
            <Table.Cell class="align-top text-right">
              <div class="tabular-nums {v.generations ? 'text-white' : 'text-dark-4'}">
                {v.generations ? num(v.generations) : '—'}
              </div>
              {#if v.generations}
                <div class="mt-0.5"><DeltaChip current={v.generations} previous={v.prevGenerations} /></div>
              {/if}
            </Table.Cell>
            <Table.Cell class="align-top text-right">
              <div class="tabular-nums {v.downloads ? 'text-white' : 'text-dark-4'}">
                {v.downloads ? num(v.downloads) : '—'}
              </div>
              {#if v.downloads}
                <div class="mt-0.5"><DeltaChip current={v.downloads} previous={v.prevDownloads} /></div>
              {/if}
            </Table.Cell>
            {#each currencies as c (c)}
              {@const cc = cell(v, c)}
              {@const show = hasDisplayValue(cc.total, c)}
              <Table.Cell class="align-top text-right">
                <div class="tabular-nums {show ? 'font-medium text-white' : 'text-dark-4'}">
                  {show ? formatAmount(cc.total, c) : '—'}
                </div>
                {#if show}
                  <div class="mt-0.5"><DeltaChip current={cc.total} previous={cc.prev} /></div>
                {/if}
              </Table.Cell>
            {/each}
          </Table.Row>
        {/each}
      </Table.Body>
    </Table.Root>
  </div>
{/if}
