<script lang="ts">
  import { enhance } from '$app/forms';
  import { Badge } from '@civitai/ui/components/ui/badge/index.js';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Label } from '@civitai/ui/components/ui/label/index.js';
  import * as Select from '@civitai/ui/components/ui/select/index.js';
  import * as Table from '@civitai/ui/components/ui/table/index.js';
  import QuoteDialog from '$lib/components/text-scan-lab/QuoteDialog.svelte';
  import { FormState } from '$lib/form-state.svelte';
  import { LINK_CLASS, dateTime, num, plural } from '$lib/format';
  import type { RunListItem, TestRun } from '$lib/server/text-scan-lab/runs.service';
  import { QUOTE_ABOVE } from '$lib/text-scan-lab/limits';
  import { scoreChips } from '$lib/text-scan-lab/score';

  let {
    runs,
    drafts,
    canRun,
    maxRunCases,
    compared,
    versionLabel,
  }: {
    runs: RunListItem[];
    drafts: { id: number; name: string; published: boolean }[];
    canRun: boolean;
    maxRunCases: number;
    compared: { a: number; b: number } | null;
    versionLabel: (run: TestRun) => string;
  } = $props();

  type Quote = {
    count: number;
    skipped: number;
    cost: number | null;
    stamp: string;
    changed: boolean;
  };

  let version = $state('active');
  let pending = $state<{ formId: string; quote: Quote } | null>(null);
  // Follow the URL's comparison, and otherwise offer the two latest runs.
  let compareA = $derived(String(compared?.a ?? runs[1]?.id ?? ''));
  let compareB = $derived(String(compared?.b ?? runs[0]?.id ?? ''));

  const versionName = (v: string) =>
    v === 'active' ? 'Active' : drafts.find((d) => String(d.id) === v)?.name ?? `Draft #${v}`;
  const runName = (id: string) => {
    const run = runs.find((r) => String(r.id) === id);
    return run ? `#${run.id} · ${versionLabel(run)}` : 'Choose a run';
  };

  function duration(run: TestRun) {
    if (!run.finishedAt) return '—';
    const s = Math.round((run.finishedAt.getTime() - run.startedAt.getTime()) / 1000);
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
  }

  /** The run form and every row's re-run form open the same quote dialog, which posts back to the
   *  form that asked. */
  let submittedFormId = $state('');
  const billed = () =>
    new FormState({
      reload: true,
      reset: false,
      onSubmit: ({ formElement }) => (submittedFormId = formElement.id),
      onSuccess: (result) => {
        pending = result?.needsConfirm
          ? { formId: submittedFormId, quote: result as unknown as Quote }
          : null;
      },
      // The refusal renders under the form, which the open dialog would cover.
      onSettled: (result) => {
        if (result.type !== 'success') pending = null;
      },
    });
  const runForm = billed();
  const rerunForm = billed();
  const submitting = $derived(runForm.submitting || rerunForm.submitting);
</script>

{#snippet runSelect(id: string, label: string, get: () => string, set: (v: string) => void)}
  <div class="flex flex-col gap-1">
    <Label for={id} class="text-xs text-dark-2">{label}</Label>
    <Select.Root type="single" bind:value={get, set}>
      <Select.Trigger {id} class="w-64">{runName(get())}</Select.Trigger>
      <Select.Content>
        {#each runs as run (run.id)}
          <Select.Item value={String(run.id)}>#{run.id} · {versionLabel(run)}</Select.Item>
        {/each}
      </Select.Content>
    </Select.Root>
  </div>
{/snippet}

<section class="mb-4 rounded-xl border border-dark-4 bg-dark-6 p-5">
  <h2 class="mb-3 text-sm font-semibold text-white">Runs</h2>

  {#if canRun}
    <form
      id="run-set"
      method="POST"
      action="?/run"
      use:enhance={runForm.enhance}
      class="flex flex-wrap items-end gap-3"
    >
      <input type="hidden" name="version" value={version} />
      <div class="flex flex-col gap-1">
        <Label for="run-version" class="text-xs text-dark-2">Run with</Label>
        <Select.Root type="single" bind:value={version}>
          <Select.Trigger id="run-version" class="w-64">{versionName(version)}</Select.Trigger>
          <Select.Content>
            <Select.Item value="active">Active</Select.Item>
            {#each drafts as d (d.id)}
              <Select.Item value={String(d.id)}>
                Draft · {d.name}{d.published ? ' (published)' : ''}
              </Select.Item>
            {/each}
          </Select.Content>
        </Select.Root>
      </div>
      <Button type="submit" disabled={submitting}>
        {runForm.submitting && !pending ? 'Running…' : 'Run'}
      </Button>
      <p class="pb-2 text-xs text-dark-2">
        One billed scan per case with text, up to {num(maxRunCases)}. Over {QUOTE_ABOVE} you confirm
        a quote first. The page waits until the run finishes.
      </p>
    </form>
    {#if runForm.error}<p class="mt-2 whitespace-pre-wrap text-sm text-red-300">{runForm.error}</p>{/if}
  {/if}

  {#if runs.length}
    <Table.Root class="mt-4">
      <Table.Header>
        <Table.Row>
          <Table.Head>Run</Table.Head>
          <Table.Head>Status</Table.Head>
          <Table.Head>Started</Table.Head>
          <Table.Head>Took</Table.Head>
          <Table.Head>Results</Table.Head>
          <Table.Head>Correct</Table.Head>
          {#if canRun}<Table.Head><span class="sr-only">Actions</span></Table.Head>{/if}
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {#each runs as run (run.id)}
          <Table.Row>
            <Table.Cell class="align-top">
              <p class="text-dark-0">#{run.id} · {versionLabel(run)}</p>
              {#if run.model}<p class="text-xs text-dark-2">{run.model}</p>{/if}
            </Table.Cell>
            <Table.Cell class="align-top">
              <Badge
                variant={run.status === 'failed'
                  ? 'destructive'
                  : run.status === 'running'
                  ? 'outline'
                  : 'secondary'}
              >
                {run.status}
              </Badge>
            </Table.Cell>
            <Table.Cell class="align-top text-xs text-dark-2">{dateTime(run.startedAt)}</Table.Cell>
            <Table.Cell class="align-top text-xs text-dark-2">{duration(run)}</Table.Cell>
            <Table.Cell class="whitespace-normal align-top text-xs text-dark-2">
              {num(run.counts.ok)} ok
              {#if run.counts.skipped}· {num(run.counts.skipped)} skipped · source deleted{/if}
              {#if run.errors.length}
                <details class="mt-1">
                  <summary class="cursor-pointer text-red-300">{plural(run.errors.length, 'error')}</summary>
                  <ul class="mt-1 max-h-48 space-y-1 overflow-y-auto">
                    {#each run.errors as e (e.caseId)}
                      <li>
                        <a href="#case-{e.caseId}" class={LINK_CLASS}>case #{e.caseId}</a>:
                        <span class="whitespace-pre-wrap break-words text-dark-0">{e.error}</span>
                      </li>
                    {/each}
                  </ul>
                </details>
              {/if}
            </Table.Cell>
            <Table.Cell class="align-top">
              <div class="flex flex-wrap gap-1">
                {#each scoreChips(run.totals) as chip (chip)}
                  <Badge variant="secondary">{chip}</Badge>
                {/each}
              </div>
            </Table.Cell>
            {#if canRun}
              <Table.Cell class="text-right align-top">
                {#if run.errors.length && run.status !== 'running'}
                  <form
                    id="rerun-{run.id}"
                    method="POST"
                    action="?/rerunErrors"
                    use:enhance={rerunForm.enhance}
                  >
                    <input type="hidden" name="runId" value={run.id} />
                    <Button type="submit" size="sm" variant="outline" disabled={submitting}>
                      {rerunForm.submitting && submittedFormId === `rerun-${run.id}` && !pending
                        ? 'Re-running…'
                        : `Re-run ${plural(run.errors.length, 'error')}`}
                    </Button>
                  </form>
                {/if}
              </Table.Cell>
            {/if}
          </Table.Row>
        {/each}
      </Table.Body>
    </Table.Root>
    {#if rerunForm.error}<p class="mt-2 whitespace-pre-wrap text-sm text-red-300">{rerunForm.error}</p>{/if}

    {#if runs.length > 1}
      <form method="GET" class="mt-4 flex flex-wrap items-end gap-3 border-t border-dark-4 pt-4">
        <input type="hidden" name="a" value={compareA} />
        <input type="hidden" name="b" value={compareB} />
        {@render runSelect('compare-a', 'Compare', () => compareA, (v) => (compareA = v))}
        {@render runSelect('compare-b', 'with', () => compareB, (v) => (compareB = v))}
        <Button type="submit" variant="outline" disabled={!compareA || !compareB || compareA === compareB}>
          Compare
        </Button>
      </form>
    {/if}
  {:else}
    <p class="mt-3 text-sm text-dark-2">Never run.</p>
  {/if}
</section>

<QuoteDialog
  quote={pending?.quote ?? null}
  formId={pending?.formId ?? ''}
  title="Scan {pending ? plural(pending.quote.count, 'case') : ''}?"
  {submitting}
  onclose={() => (pending = null)}
>
  {pending?.quote.count} billed scans.
  {#if pending?.quote.skipped}
    {plural(pending.quote.skipped, 'case')} without text will be skipped.
  {/if}
</QuoteDialog>
