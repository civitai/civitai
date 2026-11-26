<script lang="ts">
  import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
  } from '@civitai/ui/components/ui/table/index.js';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';
  import WarningAlert from '$lib/components/WarningAlert.svelte';
  import { LINK_CLASS } from '$lib/format';
  import {
    MERGE_ANALYSIS_PATH,
    NO_SIGNAL,
    SUPPORTING,
    labelCandidates,
    reportTitle,
    verdictExplanation,
    verdictLabel,
    type MergeAnalysis,
  } from '$lib/model-merge-analysis';

  let { analysis }: { analysis: MergeAnalysis } = $props();

  const tone = (verdict: string) =>
    verdict === SUPPORTING
      ? 'border-orange-500/40 bg-orange-500/10'
      : verdict === NO_SIGNAL
        ? 'border-green-500/30 bg-green-500/10'
        : 'border-yellow-500/30 bg-yellow-500/10';
  const fixed = (value: number | null | undefined, digits: number) =>
    value === null || value === undefined ? '—' : value.toFixed(digits);
</script>

<section class="flex flex-col gap-3 rounded-xl border border-dark-4 bg-dark-6 p-5" aria-live="polite">
  {#if analysis.labels}
    <dl class="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
      <dt class="text-dark-2">Checkpoint</dt>
      <dd class="break-words text-white">{analysis.labels.checkpoint}</dd>
      <dt class="text-dark-2">Original base</dt>
      <dd class="break-words text-white">{analysis.labels.baseModel}</dd>
      <dt class="text-dark-2">Candidate LoRA{analysis.labels.loras.length > 1 ? 's' : ''}</dt>
      <dd class="break-words text-white">
        {analysis.labels.loras.map((l) => l.label).join(', ')}
      </dd>
    </dl>
  {/if}

  {#if analysis.state === 'running'}
    <p class="text-white">Checking…</p>
    <p class="text-sm text-dark-2">
      Large checkpoints can take several minutes, longer the first time a model is checked. You can leave
      this page; the check keeps running and stays under Recent checks.
    </p>
  {:else if analysis.state === 'failed' || !analysis.report}
    <ErrorAlert message="The check could not be completed." />
    <p class="text-sm text-dark-2">
      A model may be unavailable for download or in a format the analysis cannot read. Check the links and
      try again; if it keeps failing, ask an engineer with workflow ID {analysis.workflowId}.
    </p>
  {:else}
    {@const report = analysis.report}
    {@const labelled = labelCandidates(report, analysis.labels)}
    <h2 class="text-lg text-white">{reportTitle(report, analysis.labels?.loras.length ?? 0)}</h2>
    <p class="text-sm text-dark-2">
      This is evidence, not proof of who made the model, and not a probability. A “no match” only concerns
      the base and LoRAs selected here.
    </p>
    {#if labelled.missing}
      <WarningAlert
        message="The report covers {report.candidates.length} of the {analysis.labels?.loras
          .length} LoRAs submitted. The others were not checked."
      />
    {/if}
    <div class="grid gap-3 sm:grid-cols-2">
      {#each labelled.candidates as { candidate, label }, i (`${i}:${candidate.name}`)}
        <article class="rounded-lg border p-4 {tone(candidate.verdict)}">
          <h3 class="text-white">{verdictLabel(candidate.verdict)}</h3>
          <p class="break-words text-sm text-white">{label}</p>
          <p class="mt-1 text-sm text-dark-2">{verdictExplanation(candidate.verdict)}</p>
        </article>
      {/each}
    </div>

    <details class="rounded-lg border border-dark-4 p-3 text-sm">
      <summary class="cursor-pointer text-dark-2">Technical details</summary>
      <div class="mt-3 overflow-x-auto">
        <Table class="text-xs">
          <TableHeader>
            <TableRow>
              <TableHead>LoRA</TableHead><TableHead>Verdict</TableHead><TableHead>Expected</TableHead>
              <TableHead>Fitted</TableHead><TableHead>Verified</TableHead><TableHead>Similarity</TableHead>
              <TableHead>Signal/rounding</TableHead><TableHead>Supporting layers</TableHead>
              <TableHead>Matched layers</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {#each report.candidates as c, i (`${i}:${c.name}`)}
              <TableRow>
                <TableCell>{c.name}</TableCell><TableCell>{c.verdict}</TableCell>
                <TableCell>{fixed(c.expectedStrength, 3)}</TableCell>
                <TableCell>{fixed(c.fittedStrength, 4)}</TableCell>
                <TableCell>{fixed(c.verificationStrength, 4)}</TableCell>
                <TableCell>{fixed(c.partialCosine, 3)}</TableCell>
                <TableCell>{fixed(c.signalToRounding, 1)}</TableCell>
                <TableCell>{c.supportingLayers} / {c.resolvableLayers}</TableCell>
                <TableCell>{c.matchedLayers} / {c.totalLayers}</TableCell>
              </TableRow>
            {/each}
          </TableBody>
        </Table>
      </div>
      <p class="mt-2 text-dark-2">
        Explained fraction {fixed(report.explainedFraction, 3)} (expected {fixed(
          report.expectedExplainedFraction,
          3
        )}), {report.verificationSamples} verification samples.
      </p>
      {#if report.warnings.length}
        <div class="mt-2 flex flex-col gap-1">
          {#each report.warnings as warning, i (i)}
            <WarningAlert message={warning} />
          {/each}
        </div>
      {/if}
      <p class="mt-2 text-dark-2">Workflow {analysis.workflowId}</p>
      {#if analysis.hasReportFile}
        <a
          class="mt-2 inline-block {LINK_CLASS}"
          href="{MERGE_ANALYSIS_PATH}/report/{encodeURIComponent(analysis.workflowId)}"
          download>Download the full report</a
        >
      {/if}
    </details>
  {/if}
</section>
