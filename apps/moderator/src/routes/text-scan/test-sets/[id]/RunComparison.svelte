<script lang="ts">
  import * as Table from '@civitai/ui/components/ui/table/index.js';
  import { LINK_CLASS, plural } from '$lib/format';
  import type { CaseFlip, RunComparison, TestRun } from '$lib/server/text-scan-lab/runs.service';
  import type { TestCase } from '$lib/server/text-scan-lab/test-sets.service';
  import { percent, type LabelTotals } from '$lib/text-scan-lab/score';

  let {
    comparison,
    cases,
    versionLabel,
  }: {
    comparison: RunComparison;
    cases: TestCase[];
    versionLabel: (run: TestRun) => string;
  } = $props();

  const { a, b } = $derived(comparison);
  const labels = $derived([
    ...new Set([...Object.keys(a.totals ?? {}), ...Object.keys(b.totals ?? {})]),
  ]);
  const caseById = $derived(new Map(cases.map((c) => [c.id, c])));

  const cell = (t: LabelTotals | undefined) =>
    t
      ? `${t.correct}/${t.scored} · P ${percent(t.precision)} · R ${percent(t.recall)}`
      : 'not scored';
  const caseName = (id: number) => {
    const c = caseById.get(id);
    if (!c) return `case #${id} (removed)`;
    return `case #${id} · ${c.entityType} ${c.entityId === null ? 'free text' : `#${c.entityId}`}`;
  };
  const json = (v: unknown) => JSON.stringify(v, null, 2);
</script>

{#snippet flips(title: string, list: CaseFlip[], tone: string)}
  <div>
    <h3 class="mb-2 text-sm font-semibold {tone}">{title} · {list.length}</h3>
    {#each list as flip (`${flip.caseId}:${flip.label}`)}
      <details class="mb-1 rounded-md border border-dark-4 bg-dark-7 px-3 py-2">
        <summary class="cursor-pointer text-sm text-dark-0">
          <a href="#case-{flip.caseId}" class={LINK_CLASS}>{caseName(flip.caseId)}</a> · {flip.label}
        </summary>
        <div class="mt-2 grid gap-2 md:grid-cols-2">
          {#each [{ side: 'A', output: flip.outputA }, { side: 'B', output: flip.outputB }] as o (o.side)}
            <div>
              <p class="text-xs text-dark-2">{o.side}</p>
              <pre class="overflow-x-auto whitespace-pre-wrap break-words text-xs text-dark-0">{json(
                  o.output
                )}</pre>
            </div>
          {/each}
        </div>
      </details>
    {:else}
      <p class="text-sm text-dark-2">None.</p>
    {/each}
  </div>
{/snippet}

<section class="mb-4 rounded-xl border border-dark-4 bg-dark-6 p-5">
  <h2 class="mb-3 text-sm font-semibold text-white">
    A #{a.id} · {versionLabel(a)} → B #{b.id} · {versionLabel(b)}
  </h2>
  {#if labels.length}
    <Table.Root>
      <Table.Header>
        <Table.Row>
          <Table.Head>Label</Table.Head>
          <Table.Head>A — correct · precision · recall</Table.Head>
          <Table.Head>B — correct · precision · recall</Table.Head>
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {#each labels as label (label)}
          <Table.Row>
            <Table.Cell class="text-dark-0">{label}</Table.Cell>
            <Table.Cell class="text-dark-0">{cell(a.totals?.[label])}</Table.Cell>
            <Table.Cell class="text-dark-0">{cell(b.totals?.[label])}</Table.Cell>
          </Table.Row>
        {/each}
      </Table.Body>
    </Table.Root>
  {:else}
    <p class="text-sm text-dark-2">Neither run scored anything.</p>
  {/if}
  <p class="mt-2 text-xs text-dark-2">
    Precision and recall count nsfw R or higher as positive. Errors and skipped cases are not scored;
    a case scored in only one run is not compared. {plural(
      comparison.newlyWrong.length + comparison.newlyRight.length,
      'label'
    )} changed.
  </p>
  <div class="mt-4 grid gap-4 lg:grid-cols-2">
    {@render flips('Newly wrong in B', comparison.newlyWrong, 'text-red-300')}
    {@render flips('Newly right in B', comparison.newlyRight, 'text-green-300')}
  </div>
</section>
