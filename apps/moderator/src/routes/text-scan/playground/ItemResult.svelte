<script lang="ts">
  import { cn } from '@civitai/ui/utils.js';
  import { compare } from '$lib/text-scan-lab/compare';
  import type { LabLabel } from '$lib/text-scan-lab/types';
  import type { RunItemResult } from './+page.server';
  import ResultPanel from './ResultPanel.svelte';

  let {
    item,
    labels,
    versionB,
  }: { item: RunItemResult; labels: readonly LabLabel[]; versionB: string } = $props();

  const rows = $derived(compare(item.a, item.b, labels));
</script>

<section class="rounded-xl border border-dark-4 bg-dark-6 p-5">
  <h3 class="text-sm font-semibold text-white">{item.title}</h3>

  <details class="mt-2">
    <summary class="text-xs text-dark-2">Text scanned</summary>
    <div class="mt-2 space-y-2">
      {#each item.fields as field, i (i)}
        <div>
          <p class="text-xs font-semibold text-dark-2">{field.heading}</p>
          <p class="whitespace-pre-wrap break-words text-sm text-dark-0">{field.text}</p>
        </div>
      {/each}
    </div>
  </details>

  <table class="mt-3 w-full text-sm">
    <thead class="text-left text-xs text-dark-2">
      <tr>
        <th class="py-1 pr-3 font-medium">Label</th>
        <th class="py-1 pr-3 font-medium">A · Active</th>
        <th class="py-1 font-medium">B · {versionB}</th>
      </tr>
    </thead>
    <tbody>
      {#each rows as row (row.label)}
        <tr class={cn('border-t border-dark-4', row.differs && 'bg-amber-500/10')}>
          <td class={cn('py-1 pr-3', row.differs ? 'font-semibold text-amber-200' : 'text-white')}>
            {row.label}{row.differs ? ' · differs' : ''}
          </td>
          <td class="break-words py-1 pr-3 text-dark-0">{row.a}</td>
          <td class="break-words py-1 text-dark-0">{row.b}</td>
        </tr>
      {/each}
    </tbody>
  </table>

  <div class="mt-4 grid gap-3 lg:grid-cols-2">
    <ResultPanel title="A · Active" result={item.a} {labels} />
    <ResultPanel title="B · {versionB}" result={item.b} {labels} />
  </div>
</section>
