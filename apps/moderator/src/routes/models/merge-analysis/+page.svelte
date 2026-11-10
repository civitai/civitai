<script lang="ts">
  import { applyAction, enhance } from '$app/forms';
  import { invalidateAll } from '$app/navigation';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Input } from '@civitai/ui/components/ui/input/index.js';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';
  import { MAX_CANDIDATE_LORAS, MERGE_ANALYSIS_PATH, reportTitle } from '$lib/model-merge-analysis';
  import AnalysisResult from './AnalysisResult.svelte';
  import ModelLinkInput from './ModelLinkInput.svelte';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  let submitting = $state(false);
  let loraRows = $state([0]);
  let nextRow = 1;

  const running = $derived(data.current?.state === 'running');

  $effect(() => {
    if (!running) return;
    const timer = setInterval(() => invalidateAll(), 10_000);
    return () => clearInterval(timer);
  });

  const EXAMPLES = [
    {
      name: 'Merge evidence expected',
      checkpoint: 'https://civitai.com/model-versions/3107962',
      base: 'https://civitai.com/model-versions/3064584',
      lora: 'https://civitai.com/model-versions/3070702',
    },
    {
      name: 'No match expected (the base checked against itself)',
      checkpoint: 'https://civitai.com/model-versions/3064584',
      base: 'https://civitai.com/model-versions/3064584',
      lora: 'https://civitai.com/model-versions/3070702',
    },
  ];
</script>

<svelte:head><title>Model merge analysis</title></svelte:head>

<div class="flex max-w-4xl flex-col gap-5">
  <div>
    <h1 class="text-xl text-white">Model merge analysis</h1>
    <p class="text-sm text-dark-2">
      Checks whether a checkpoint contains one or more LoRAs merged into its original base. Paste links;
      the models are downloaded and compared by the orchestrator, nothing is uploaded from here.
    </p>
  </div>

  {#if data.currentUnavailable}
    <ErrorAlert message="Could not reach the orchestrator to read this check. Reload to try again." />
  {:else if data.current}
    <AnalysisResult analysis={data.current} />
  {/if}

  {#if data.grants['model.mergeAnalysis.run']}
    <form
      method="POST"
      action="?/check"
      class="flex flex-col gap-4 rounded-xl border border-dark-4 bg-dark-6 p-5"
      use:enhance={() => {
        submitting = true;
        return async ({ result }) => {
          try {
            await applyAction(result);
          } finally {
            submitting = false;
          }
        };
      }}
    >
      <ModelLinkInput
        id="checkpoint"
        label="Checkpoint to investigate"
        hint="The checkpoint you suspect contains a merged LoRA."
        role="checkpoint"
        name="checkpoint"
        labelName="checkpointLabel"
      />
      <ModelLinkInput
        id="base"
        label="Original base checkpoint"
        hint="The exact checkpoint it was made from."
        role="checkpoint"
        name="baseModel"
        labelName="baseModelLabel"
      />

      {#each loraRows as row, i (row)}
        <div class="flex flex-col gap-2 rounded-lg border border-dark-4 p-3">
          <ModelLinkInput
            id="lora-{row}"
            label={loraRows.length > 1 ? `Candidate LoRA ${i + 1}` : 'Candidate LoRA'}
            hint="A LoRA you suspect was merged in."
            role="lora"
            name="lora"
            labelName="loraLabel"
          />
          <details class="text-sm">
            <summary class="text-dark-2">Advanced</summary>
            <label class="mt-2 flex flex-wrap items-center gap-2 text-dark-2">
              Suspected strength (optional)
              <Input name="strength" type="number" step="0.05" min="-10" max="10" placeholder="1" class="w-28" />
            </label>
            <p class="mt-1 text-xs text-dark-2">
              Only a hint; the actual strength is measured independently.
            </p>
          </details>
          {#if loraRows.length > 1}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              class="self-start"
              onclick={() => (loraRows = loraRows.filter((r) => r !== row))}>Remove this LoRA</Button
            >
          {/if}
        </div>
      {/each}

      <div class="flex flex-wrap gap-2">
        {#if loraRows.length < MAX_CANDIDATE_LORAS}
          <Button type="button" variant="outline" onclick={() => (loraRows = [...loraRows, nextRow++])}>
            Add another LoRA
          </Button>
        {/if}
        <Button type="submit" disabled={submitting || running}>
          {submitting ? 'Starting…' : 'Check for merged LoRAs'}
        </Button>
      </div>
      {#if running}
        <p class="text-sm text-dark-2">Wait for the check above to finish before starting another.</p>
      {/if}
      {#if form?.error}
        <ErrorAlert message={form.error} />
      {/if}
    </form>
  {:else}
    <p class="text-sm text-dark-2">You can view checks here, but you do not hold the grant to run one.</p>
  {/if}

  <details class="rounded-xl border border-dark-4 p-4 text-sm">
    <summary class="text-dark-1">Examples to try</summary>
    {#each EXAMPLES as example (example.name)}
      <div class="mt-3">
        <p class="text-white">{example.name}</p>
        <ul class="text-dark-2">
          <li>Checkpoint to investigate: <code class="break-all">{example.checkpoint}</code></li>
          <li>Original base checkpoint: <code class="break-all">{example.base}</code></li>
          <li>Candidate LoRA: <code class="break-all">{example.lora}</code>, suspected strength 0.75</li>
        </ul>
      </div>
    {/each}
  </details>

  <section class="flex flex-col gap-2">
    <h2 class="text-white">Recent checks</h2>
    {#await data.recent}
      <p class="text-sm text-dark-2">Loading…</p>
    {:then recent}
      {#if recent === null}
        <ErrorAlert message="Could not load recent checks." />
      {:else}
        <ul class="flex flex-col gap-1 text-sm">
          {#each recent as check (check.workflowId)}
            <li>
              <a
                class="flex flex-wrap gap-x-3 rounded px-2 py-1 hover:bg-dark-5"
                href="{MERGE_ANALYSIS_PATH}?workflow={encodeURIComponent(check.workflowId)}"
              >
                <span class="text-white">{check.labels?.checkpoint ?? check.workflowId}</span>
                <span class="text-dark-2">
                  {check.state === 'running'
                    ? 'Checking…'
                    : check.state === 'failed' || !check.report
                      ? 'Could not complete'
                      : reportTitle(check.report)}
                </span>
                {#if check.createdAt}
                  <span class="text-dark-2">{new Date(check.createdAt).toLocaleString()}</span>
                {/if}
              </a>
            </li>
          {:else}
            <li class="text-dark-2">No checks yet.</li>
          {/each}
        </ul>
      {/if}
    {:catch}
      <ErrorAlert message="Could not load recent checks." />
    {/await}
  </section>
</div>
