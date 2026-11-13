<script lang="ts">
  import { enhance } from '$app/forms';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { FormState } from '$lib/form-state.svelte';
  import type { ReportCase, ReportSide } from '$lib/server/text-scan-tests/reports';
  import {
    ENTITY_TYPE_NAMES,
    LABEL_NAMES,
    describeVerdict,
    type VerdictSource,
  } from '$lib/text-scan-lab/labels';
  import { LAB_LABELS, type LabLabel } from '$lib/text-scan-lab/types';
  import { scoredLabels, type Expected, type FlagLabel } from '$lib/text-scan-tests/expected';
  import type { Flip } from '$lib/text-scan-tests/score';
  import ExpectedEditor from './ExpectedEditor.svelte';

  let {
    row,
    canEdit,
    setId,
  }: {
    row: ReportCase;
    canEdit: boolean;
    setId: number;
  } = $props();

  const FLIP_BADGE: Record<Flip, { text: string; tone: string } | null> = {
    regressed: { text: 'Now fails', tone: 'border-red-500/60 text-red-300' },
    fixed: { text: 'Now passes', tone: 'border-green-500/60 text-green-300' },
    'still-failing': { text: 'Fails', tone: 'border-amber-500/60 text-amber-300' },
    'not-compared': null,
    'still-passing': null,
  };

  let editing = $state(false);
  let expected = $state<Expected>({});
  const edit = new FormState({ reset: false, reload: true, onSuccess: () => (editing = false) });

  const badge = $derived(FLIP_BADGE[row.flip]);
  const sides = $derived(
    [
      { title: 'Baseline', side: row.baseline },
      { title: 'Draft', side: row.draft },
    ].filter((s): s is { title: string; side: ReportSide } => s.side !== null)
  );
  const labels = $derived(scoredLabels(row.expected));

  function source(side: ReportSide): VerdictSource {
    const result = side.result;
    if (result?.status === 'ok')
      return { ok: true, output: result.output as Record<string, unknown> | null };
    const fallback = result?.status === 'skipped' ? 'text removed' : 'not scanned';
    return { ok: false, error: result?.error ?? fallback };
  }

  function expectedText(label: LabLabel): string {
    const e = row.expected;
    if (label === 'nsfw' && e.nsfw)
      return e.nsfw.min === e.nsfw.max ? e.nsfw.min : `${e.nsfw.min}–${e.nsfw.max}`;
    const flag = e[label as FlagLabel];
    return flag === undefined ? '—' : flag ? 'yes' : 'no';
  }

  function startEditing() {
    expected = $state.snapshot(row.expected);
    editing = true;
  }
</script>

<section class="rounded-xl border border-dark-4 bg-dark-6 p-4">
  <div class="flex flex-wrap items-center gap-2">
    <h3 class="text-sm font-semibold text-white">
      Case {row.caseId} · {ENTITY_TYPE_NAMES[row.entityType]}{row.entityId !== null
        ? ` ${row.entityId}`
        : ''}
    </h3>
    {#if badge}<Badge variant="outline" class={badge.tone}>{badge.text}</Badge>{/if}
    {#if row.wiped}<Badge variant="secondary">Text removed</Badge>{/if}
    {#if canEdit && !editing}
      <Button size="xs" variant="ghost" class="ml-auto" onclick={startEditing}>
        Edit expectation
      </Button>
    {/if}
  </div>
  {#if row.preview}
    <p class="mt-1 line-clamp-2 break-words text-xs text-dark-2">{row.preview}</p>
  {/if}
  {#if row.note}<p class="mt-1 text-xs text-dark-2">Note: {row.note}</p>{/if}

  <div class="mt-3 grid gap-2">
    {#each labels as label (label)}
      <div class="grid gap-2 text-sm sm:grid-cols-[8rem_1fr_1fr_1fr]">
        <span class="text-xs font-semibold uppercase tracking-wide text-dark-2">
          {LABEL_NAMES[label]}
        </span>
        <span class="text-dark-0">Expected: {expectedText(label)}</span>
        {#each sides as { title, side } (title)}
          {@const outcome =
            side.score.state === 'scored'
              ? side.score.labels.find((o) => o.label === label)
              : undefined}
          <span class={outcome ? (outcome.pass ? 'text-green-300' : 'text-red-300') : 'text-dark-2'}>
            {title}: {describeVerdict(label, source(side)).headline}{outcome
              ? outcome.pass
                ? ' ✓'
                : ' ✗'
              : ''}
          </span>
        {/each}
      </div>
    {/each}
  </div>

  <details class="mt-3">
    <summary class="cursor-pointer text-xs text-dark-2">Details</summary>
    <div class="mt-2 grid gap-3 xl:grid-cols-2">
      {#each sides as { title, side } (title)}
        <div class="min-w-0 rounded-lg border border-dark-4 bg-dark-7 p-3">
          <h4 class="text-xs font-semibold uppercase tracking-wide text-dark-2">{title}</h4>
          {#if side.result?.workflowId}
            <p class="mt-1 break-all text-xs text-dark-2">
              Workflow <span class="font-mono text-dark-0">{side.result.workflowId}</span>
            </p>
          {/if}
          {#if side.result?.error}<p class="mt-1 text-sm text-red-300">{side.result.error}</p>{/if}
          {#if side.result?.output}
            <pre class="mt-2 overflow-x-auto text-xs text-dark-0">{JSON.stringify(
                side.result.output,
                null,
                2
              )}</pre>
          {/if}
        </div>
      {/each}
    </div>
  </details>

  {#if editing}
    <form
      method="POST"
      action="?/editCase"
      use:enhance={edit.enhance}
      class="mt-3 space-y-3 border-t border-dark-4 pt-3"
    >
      <input type="hidden" name="setId" value={setId} />
      <input type="hidden" name="caseId" value={row.caseId} />
      <input type="hidden" name="note" value={row.note ?? ''} />
      <ExpectedEditor
        labels={LAB_LABELS[row.entityType]}
        bind:expected
        idPrefix="case-{row.caseId}"
      />
      {#if edit.error}<p class="text-sm text-red-300">{edit.error}</p>{/if}
      <div class="flex gap-2">
        <Button type="submit" size="sm" disabled={edit.submitting}>
          {edit.submitting ? 'Saving…' : 'Save expectation'}
        </Button>
        <Button type="button" size="sm" variant="ghost" onclick={() => (editing = false)}>
          Cancel
        </Button>
      </div>
    </form>
  {/if}
</section>
