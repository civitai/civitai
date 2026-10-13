<script lang="ts">
  import VersionPicker from '$lib/components/text-scan-lab/VersionPicker.svelte';
  import { dateTime } from '$lib/format';
  import { ruleVersionDiff, type ModelRuleVersionView } from '$lib/model-rule-versions';
  import { defaultComparePair } from '$lib/text-scan-lab/compare';

  let { versions }: { versions: ModelRuleVersionView[] } = $props();

  let picked = $state<{ from: number; to: number } | null>(null);
  const pair = $derived(picked ?? defaultComparePair(versions));
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
  <table class="w-full text-sm">
    <thead>
      <tr class="text-left text-xs text-dark-2">
        <th class="py-1 pr-3 font-semibold">Field</th>
        <th class="py-1 pr-3 font-semibold">From</th>
        <th class="py-1 font-semibold">To</th>
      </tr>
    </thead>
    <tbody>
      {#each rows as row (row.field)}
        <tr class={row.changed ? 'text-amber-200' : 'text-dark-2'}>
          <th class="py-1 pr-3 text-left align-top text-xs font-semibold">{row.field}</th>
          <td class="whitespace-pre-wrap break-words py-1 pr-3 align-top">{row.before || '—'}</td>
          <td class="whitespace-pre-wrap break-words py-1 align-top">{row.after || '—'}</td>
        </tr>
      {/each}
    </tbody>
  </table>
{:else}
  <p class="text-xs text-dark-2">One version so far; nothing to compare yet.</p>
{/if}
