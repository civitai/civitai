<script lang="ts">
  import {
    MERGE_ANALYSIS_PATH,
    NO_SIGNAL,
    SUPPORTING,
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
      <dd class="break-words text-white">{analysis.labels.loras.join(', ')}</dd>
    </dl>
  {/if}

  {#if analysis.state === 'running'}
    <p class="text-white">Checking…</p>
    <p class="text-sm text-dark-2">
      Large checkpoints can take several minutes, longer the first time a model is checked. You can leave
      this page; the check keeps running and stays under Recent checks.
    </p>
  {:else if analysis.state === 'failed' || !analysis.report}
    <p class="text-red-300">The check could not be completed.</p>
    <p class="text-sm text-dark-2">
      A model may be unavailable for download or in a format the analysis cannot read. Check the links and
      try again; if it keeps failing, ask an engineer with workflow ID {analysis.workflowId}.
    </p>
  {:else}
    {@const report = analysis.report}
    <h2 class="text-lg text-white">{reportTitle(report)}</h2>
    <p class="text-sm text-dark-2">
      This is evidence, not proof of who made the model, and not a probability. A “no match” only concerns
      the base and LoRAs selected here.
    </p>
    <div class="grid gap-3 sm:grid-cols-2">
      {#each report.candidates as candidate, i (`${i}:${candidate.name}`)}
        <article class="rounded-lg border p-4 {tone(candidate.verdict)}">
          <h3 class="text-white">{verdictLabel(candidate.verdict)}</h3>
          <p class="break-words text-sm text-white">{analysis.labels?.loras[i] ?? candidate.name}</p>
          <p class="mt-1 text-sm text-dark-2">{verdictExplanation(candidate.verdict)}</p>
        </article>
      {/each}
    </div>

    <details class="rounded-lg border border-dark-4 p-3 text-sm">
      <summary class="text-dark-1">Technical details</summary>
      <div class="mt-3 overflow-x-auto">
        <table class="w-full text-left text-xs">
          <thead class="text-dark-2">
            <tr>
              <th class="p-1">LoRA</th><th class="p-1">Verdict</th><th class="p-1">Expected</th>
              <th class="p-1">Fitted</th><th class="p-1">Verified</th><th class="p-1">Similarity</th>
              <th class="p-1">Signal/rounding</th><th class="p-1">Supporting layers</th>
              <th class="p-1">Matched layers</th>
            </tr>
          </thead>
          <tbody>
            {#each report.candidates as c, i (`${i}:${c.name}`)}
              <tr class="border-t border-dark-4">
                <td class="p-1">{c.name}</td><td class="p-1">{c.verdict}</td>
                <td class="p-1">{fixed(c.expectedStrength, 3)}</td>
                <td class="p-1">{fixed(c.fittedStrength, 4)}</td>
                <td class="p-1">{fixed(c.verificationStrength, 4)}</td>
                <td class="p-1">{fixed(c.partialCosine, 3)}</td>
                <td class="p-1">{fixed(c.signalToRounding, 1)}</td>
                <td class="p-1">{c.supportingLayers} / {c.resolvableLayers}</td>
                <td class="p-1">{c.matchedLayers} / {c.totalLayers}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      <p class="mt-2 text-dark-2">
        Explained fraction {fixed(report.explainedFraction, 3)} (expected {fixed(
          report.expectedExplainedFraction,
          3
        )}), {report.verificationSamples} verification samples.
      </p>
      {#if report.warnings.length}
        <ul class="mt-2 list-disc pl-5 text-yellow-200">
          {#each report.warnings as warning, i (i)}
            <li>{warning}</li>
          {/each}
        </ul>
      {/if}
      <p class="mt-2 text-dark-2">Workflow {analysis.workflowId}</p>
      {#if analysis.hasReportFile}
        <a
          class="mt-2 inline-block text-blue-400 underline"
          href="{MERGE_ANALYSIS_PATH}/report/{encodeURIComponent(analysis.workflowId)}"
          download>Download the full report</a
        >
      {/if}
    </details>
  {/if}
</section>
