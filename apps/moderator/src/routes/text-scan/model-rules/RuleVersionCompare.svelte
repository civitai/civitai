<script lang="ts">
  import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
  } from '@civitai/ui/components/ui/table/index.js';
  import VersionPicker from '$lib/components/text-scan-lab/VersionPicker.svelte';
  import { dateTime } from '$lib/format';
  import { ruleVersionDiff, type ModelRuleVersionView } from '$lib/model-rule-versions';
  import { resolvePair } from '$lib/text-scan-lab/compare';

  let { versions }: { versions: ModelRuleVersionView[] } = $props();

  let picked = $state<{ from: number; to: number } | null>(null);
  const pair = $derived(resolvePair(picked, versions));
  const options = $derived(
    versions.map((v) => ({ id: v.id, label: `#${v.id} · ${dateTime(v.createdAt)}` }))
  );
  const rows = $derived.by(() => {
    if (!pair) return [];
    const from = versions.find((v) => v.id === pair.from);
    const to = versions.find((v) => v.id === pair.to);
    return from && to ? ruleVersionDiff(from, to) : [];
  });
</script>

{#if pair}
  {@const from = pair.from}
  {@const to = pair.to}
  <div class="flex flex-wrap items-end gap-3">
    <VersionPicker
      id="rule-compare-from"
      label="From"
      value={from}
      {options}
      onchange={(id) => (picked = { from: id, to })}
    />
    <VersionPicker
      id="rule-compare-to"
      label="To"
      value={to}
      {options}
      onchange={(id) => (picked = { from, to: id })}
    />
  </div>
  <Table class="text-sm">
    <TableHeader>
      <TableRow class="text-xs text-dark-2">
        <TableHead>Field</TableHead>
        <TableHead>From</TableHead>
        <TableHead>To</TableHead>
      </TableRow>
    </TableHeader>
    <TableBody>
      {#each rows as row (row.field)}
        <TableRow class={row.changed ? 'text-amber-200' : 'text-dark-2'}>
          <TableCell class="align-top text-xs font-semibold">{row.field}</TableCell>
          <TableCell class="whitespace-pre-wrap break-words align-top">{row.before || '—'}</TableCell>
          <TableCell class="whitespace-pre-wrap break-words align-top">{row.after || '—'}</TableCell>
        </TableRow>
      {/each}
    </TableBody>
  </Table>
{:else}
  <p class="text-xs text-dark-2">One version so far; nothing to compare yet.</p>
{/if}
