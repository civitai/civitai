<script lang="ts">
  import { applyAction, enhance } from '$app/forms';
  import { invalidateAll } from '$app/navigation';
  import { Button } from '@civitai/ui/components/ui/button/index.js';
  import { Checkbox } from '@civitai/ui/components/ui/checkbox/index.js';
  import { Label } from '@civitai/ui/components/ui/label/index.js';
  import { Textarea } from '@civitai/ui/components/ui/textarea/index.js';
  import ErrorAlert from '$lib/components/ErrorAlert.svelte';
  import { NOT_AVAILABLE } from '$lib/scan-probe';
  import ProbeResult from './ProbeResult.svelte';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  let submitting = $state(false);
  const refused = $derived(form && 'refused' in form ? (form.refused ?? []) : []);
  const stopped = $derived(data.stopped === true);
</script>

<svelte:head><title>Scan Probe</title></svelte:head>

<div class="flex flex-col gap-5">
  <div>
    <h1 class="text-xl text-white">Scan Probe</h1>
    <p class="text-sm text-dark-2">
      Runs the image scanner on images you choose and shows its signals, never the image. Up to
      {data.limits.perRun} ids per run, {data.limits.perModeratorPerHour} an hour. The result may be a verdict
      the scanner already held for the same image, not a fresh scan.
    </p>
  </div>

  <div class="rounded-md border border-yellow-500/30 bg-yellow-500/10 p-3 text-sm text-yellow-200" role="note">
    A hit acts on the real image. If the scan blocks it, the block sticks: the image can be served differently
    and rejected wherever else it is used. A block also stops this tool until an admin resets it.
  </div>

  {#if data.stopped === null}
    <ErrorAlert message="Could not load the probe's state." />
  {:else if stopped}
    <div class="rounded-xl border border-red-500/30 bg-red-500/10 p-5 text-sm text-red-300">
      <p>The probe is stopped: a scan came back blocked, failed, or with an outcome it could not read.</p>
      {#if data.tripped?.length}
        <p class="mt-1">
          {data.tripped.map((r) => `Run ${r.id} (image ${r.imageId})`).join(', ')}
        </p>
      {/if}
      {#if data.canReset}
        <form method="POST" action="?/resetBreaker" use:enhance class="mt-3">
          <Button type="submit" variant="destructive">Reset the probe</Button>
        </form>
      {/if}
    </div>
  {/if}

  {#if data.grants['image.scanProbe.run'] && data.stopped === false}
    <form
      method="POST"
      action="?/run"
      class="rounded-xl border border-dark-4 bg-dark-6 p-5"
      use:enhance={() => {
        submitting = true;
        // A refusal can mean the breaker just tripped or runs were written: reload the page data
        // either way, which the default handling only does on success.
        return async ({ result }) => {
          await applyAction(result);
          await invalidateAll();
          submitting = false;
        };
      }}
    >
      <Label for="ids">Image ids</Label>
      <Textarea id="ids" name="ids" rows={2} placeholder="123, 456" class="mt-1" />
      <div class="mt-3 flex items-center gap-2">
        <Checkbox id="understood" name="understood" />
        <Label for="understood" class="text-sm text-dark-2">I understand a hit acts on the real image.</Label>
      </div>
      <Button type="submit" class="mt-3" disabled={submitting}>
        {submitting ? 'Submitting…' : 'Run scan'}
      </Button>
    </form>
  {:else if !data.grants['image.scanProbe.run']}
    <p class="text-sm text-dark-2">You do not hold the grant to run the probe.</p>
  {/if}

  {#if form && 'error' in form && form.error}
    <ErrorAlert message={form.error} />
  {:else if form && 'submitted' in form}
    <p class="text-sm text-dark-2">
      Submitted {form.submitted}{form.failed ? `, ${form.failed} could not be submitted` : ''}.
    </p>
  {:else if form && 'reset' in form}
    <p class="text-sm text-dark-2">The probe is reset.</p>
  {/if}
  {#if refused.length}
    <p class="text-sm text-dark-2">{refused.join(', ')}: {NOT_AVAILABLE}</p>
  {/if}

  {#if data.runs === null}
    <ErrorAlert message="Could not load your recent runs." />
  {:else}
    {#each data.runs as run (run.id)}
      <ProbeResult {run} />
    {:else}
      <p class="text-sm text-dark-2">No runs yet.</p>
    {/each}
  {/if}
</div>
